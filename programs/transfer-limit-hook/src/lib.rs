//! Token-2022 transfer hook that caps how much each wallet can send per
//! rolling time window (for example "at most 1,000 tokens per 24 hours").
//!
//! Use case: spending limits for hot wallets, agent wallets or treasury
//! operators. If the key leaks, the attacker can only move one window's worth.
//!
//! Accounts the hook receives from Token-2022 on every transfer:
//!   0 source token account   1 mint   2 destination token account
//!   3 source authority (owner *or delegate*)   4 ExtraAccountMetaList
//!   5 config  PDA ["config", mint]
//!   6 usage   PDA ["usage", mint, source_token.owner]
//!
//! The usage PDA is keyed by the source token account's **owner**, read from
//! the account data (bytes 32..64), not by account 3. Account 3 is the
//! delegate when a delegate signs, so keying by it would let an owner bypass
//! the limit by approving a fresh delegate for every transfer.

use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::spl_token_2022::{
        extension::{
            transfer_hook::TransferHookAccount, BaseStateWithExtensions, PodStateWithExtensions,
        },
        pod::PodAccount,
    },
    token_interface::{Mint, TokenAccount},
};
use spl_discriminator::SplDiscriminate;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

declare_id!("AdBKiZ1PFPNB2XW3SDQFZWPnjRdkocDKHhjkPLioxumC");

pub const CONFIG_SEED: &[u8] = b"config";
pub const USAGE_SEED: &[u8] = b"usage";
pub const META_LIST_SEED: &[u8] = b"extra-account-metas";

#[program]
pub mod transfer_limit_hook {
    use super::*;

    /// Sets the limit for a mint and writes the ExtraAccountMetaList that
    /// tells Token-2022 which extra accounts to pass to the hook.
    /// Only the mint authority can call it.
    pub fn initialize(ctx: Context<Initialize>, limit: u64, window_secs: i64) -> Result<()> {
        validate(limit, window_secs)?;
        ctx.accounts.config.set_inner(Config {
            authority: ctx.accounts.authority.key(),
            mint: ctx.accounts.mint.key(),
            limit,
            window_secs,
            bump: ctx.bumps.config,
            meta_list_bump: ctx.bumps.extra_account_meta_list,
        });
        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &extra_account_metas()?,
        )
        // spl-tlv-account-resolution uses solana-program-error 2.x, Anchor 1.x uses 3.x
        .map_err(|_| ProgramError::InvalidAccountData)?;
        Ok(())
    }

    /// Changes the limit or window. Only the config authority.
    pub fn set_limit(ctx: Context<SetLimit>, limit: u64, window_secs: i64) -> Result<()> {
        validate(limit, window_secs)?;
        let config = &mut ctx.accounts.config;
        config.limit = limit;
        config.window_secs = window_secs;
        Ok(())
    }

    /// Creates the usage account for `owner`. Anyone can pay for it.
    /// The hook can't create it itself: it gets no payer during a transfer.
    pub fn open_usage(ctx: Context<OpenUsage>, owner: Pubkey) -> Result<()> {
        ctx.accounts.usage.set_inner(Usage {
            owner,
            window_start: 0,
            used: 0,
            bump: ctx.bumps.usage,
        });
        Ok(())
    }

    /// Called by Token-2022 inside every `transfer_checked` of the mint.
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        // Without this, anyone could call the hook directly and burn through
        // another wallet's allowance.
        check_is_transferring(&ctx.accounts.source_token.to_account_info())?;

        let owner = ctx.accounts.source_token.owner;
        let config = &ctx.accounts.config;
        // The issuer distributes supply, so its own transfers are not limited.
        if owner == config.authority {
            return Ok(());
        }

        let usage_info = ctx.accounts.usage.to_account_info();
        require_keys_eq!(*usage_info.owner, crate::ID, LimitError::UsageNotOpened);
        // Checks the 8-byte discriminator, so only a real Usage account loads.
        let mut usage = Usage::try_deserialize(&mut &usage_info.try_borrow_data()?[..])?;
        require_keys_eq!(usage.owner, owner, LimitError::UsageNotOpened);
        // Bind it to this mint and owner with the stored bump: one hash instead
        // of the bump search a `seeds` constraint without a known bump does.
        let mint = ctx.accounts.mint.key();
        let expected = Pubkey::create_program_address(
            &[USAGE_SEED, mint.as_ref(), owner.as_ref(), &[usage.bump]],
            &crate::ID,
        )
        .map_err(|_| LimitError::UsageNotOpened)?;
        require_keys_eq!(expected, usage_info.key(), LimitError::UsageNotOpened);

        let now = Clock::get()?.unix_timestamp;
        if now.saturating_sub(usage.window_start) >= config.window_secs {
            usage.window_start = now;
            usage.used = 0;
        }
        let used = usage
            .used
            .checked_add(amount)
            .ok_or(LimitError::LimitExceeded)?;
        if used > config.limit {
            msg!(
                "limit {} per {}s, already sent {}, tried {}",
                config.limit,
                config.window_secs,
                usage.used,
                amount
            );
            return err!(LimitError::LimitExceeded);
        }
        usage.used = used;
        usage.try_serialize(&mut &mut usage_info.try_borrow_mut_data()?[..])?;
        Ok(())
    }
}

fn validate(limit: u64, window_secs: i64) -> Result<()> {
    require!(limit > 0 && window_secs > 0, LimitError::InvalidConfig);
    Ok(())
}

/// Extra accounts Token-2022 resolves and appends on every transfer.
pub fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
    let metas = [
        // 5: config = ["config", mint]
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: CONFIG_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
            ],
            false,
            false,
        ),
        // 6: usage = ["usage", mint, source_token.owner]; the owner is read from
        //    the source token account's data at offset 32.
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: USAGE_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                Seed::AccountData {
                    account_index: 0,
                    data_index: 32,
                    length: 32,
                },
            ],
            false,
            true,
        ),
    ];
    metas
        .into_iter()
        .map(|m| m.map_err(|_| ProgramError::InvalidArgument.into()))
        .collect()
}

pub const EXTRA_ACCOUNT_METAS: usize = 2;

fn check_is_transferring(source: &AccountInfo) -> Result<()> {
    let data = source.try_borrow_data()?;
    let account = PodStateWithExtensions::<PodAccount>::unpack(&data)
        .map_err(|_| ProgramError::InvalidAccountData)?;
    let ext = account
        .get_extension::<TransferHookAccount>()
        .map_err(|_| ProgramError::InvalidAccountData)?;
    require!(bool::from(ext.transferring), LimitError::NotTransferring);
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mint::token_program = anchor_spl::token_2022::ID,
        constraint = mint.mint_authority == Some(authority.key()).into() @ LimitError::NotMintAuthority,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED, mint.key().as_ref()],
        bump,
    )]
    pub config: Account<'info, Config>,

    /// CHECK: written by `ExtraAccountMetaList::init`; address fixed by the seeds.
    #[account(
        init,
        payer = authority,
        space = ExtraAccountMetaList::size_of(EXTRA_ACCOUNT_METAS).unwrap(),
        seeds = [META_LIST_SEED, mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetLimit<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ LimitError::Unauthorized,
        seeds = [CONFIG_SEED, config.mint.as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct OpenUsage<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED, config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = payer,
        space = 8 + Usage::INIT_SPACE,
        seeds = [USAGE_SEED, config.mint.as_ref(), owner.as_ref()],
        bump,
    )]
    pub usage: Account<'info, Usage>,
    pub system_program: Program<'info, System>,
}

// Account order is fixed by the transfer-hook interface (see the module docs).
#[derive(Accounts)]
pub struct TransferHook<'info> {
    #[account(token::mint = mint)]
    pub source_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(token::mint = mint)]
    pub destination_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the owner or a delegate; Token-2022 already checked the signature.
    /// Deliberately not constrained to `source_token.owner`, which would reject
    /// every delegated transfer.
    pub authority: UncheckedAccount<'info>,
    /// CHECK: address fixed by the seeds.
    #[account(seeds = [META_LIST_SEED, mint.key().as_ref()], bump = config.meta_list_bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED, mint.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: may be uninitialized for the issuer. Otherwise the handler checks
    /// owner program, discriminator, `owner` field and PDA (with the stored bump).
    #[account(mut)]
    pub usage: UncheckedAccount<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub mint: Pubkey,
    /// Maximum base units one owner may send per window.
    pub limit: u64,
    pub window_secs: i64,
    pub bump: u8,
    pub meta_list_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Usage {
    pub owner: Pubkey,
    pub window_start: i64,
    pub used: u64,
    pub bump: u8,
}

#[error_code]
pub enum LimitError {
    #[msg("Transfer exceeds this wallet's limit for the current window")]
    LimitExceeded,
    #[msg("This wallet has no usage account yet: call open_usage first")]
    UsageNotOpened,
    #[msg("The hook can only run inside a Token-2022 transfer")]
    NotTransferring,
    #[msg("Only the mint authority can configure the hook")]
    NotMintAuthority,
    #[msg("Only the config authority can change the limit")]
    Unauthorized,
    #[msg("Limit and window must both be greater than zero")]
    InvalidConfig,
}
