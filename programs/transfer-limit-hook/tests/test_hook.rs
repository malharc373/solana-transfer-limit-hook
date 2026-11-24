//! LiteSVM tests. Run `anchor build` first (they load target/deploy/*.so).
//!
//! Every transfer goes through the real Token-2022 program, which resolves the
//! ExtraAccountMetaList and CPIs into the hook, so these test the hook exactly
//! as wallets and programs will hit it.

use {
    anchor_lang::{
        solana_program::{
            clock::Clock,
            instruction::{AccountMeta, Instruction},
            pubkey::Pubkey,
            system_instruction::create_account,
            system_program,
        },
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::{
        associated_token::{
            get_associated_token_address_with_program_id,
            spl_associated_token_account::instruction::create_associated_token_account,
        },
        token_2022::{
            spl_token_2022::{
                self,
                extension::{transfer_hook as hook_extension, ExtensionType},
                state::Mint,
            },
            ID as TOKEN_2022,
        },
        token_interface::TokenAccount,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    transfer_limit_hook::{accounts, instruction, Usage, CONFIG_SEED, META_LIST_SEED, USAGE_SEED},
};

const DECIMALS: u8 = 6;
const UNIT: u64 = 1_000_000;
const LIMIT: u64 = 100 * UNIT;
const DAY: i64 = 86_400;
const START: i64 = 1_795_000_000;

struct Env {
    svm: LiteSVM,
    issuer: Keypair,
    alice: Keypair,
    bob: Keypair,
    mint: Pubkey,
}

fn id() -> Pubkey {
    transfer_limit_hook::id()
}

fn send(
    svm: &mut LiteSVM,
    ixs: &[Instruction],
    payer: &Keypair,
    signers: &[&Keypair],
) -> Result<Vec<String>, String> {
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    let res = svm
        .send_transaction(tx)
        .map(|m| m.logs)
        .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
    svm.expire_blockhash();
    res
}

fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(owner, mint, &TOKEN_2022)
}
fn config_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED, mint.as_ref()], &id()).0
}
fn usage_pda(mint: &Pubkey, owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[USAGE_SEED, mint.as_ref(), owner.as_ref()], &id()).0
}
fn meta_list_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[META_LIST_SEED, mint.as_ref()], &id()).0
}

fn balance(svm: &LiteSVM, owner: &Pubkey, mint: &Pubkey) -> u64 {
    let acc = svm.get_account(&ata(owner, mint)).unwrap();
    TokenAccount::try_deserialize(&mut acc.data.as_slice())
        .unwrap()
        .amount
}

fn usage(env: &Env, owner: &Pubkey) -> Usage {
    let acc = env.svm.get_account(&usage_pda(&env.mint, owner)).unwrap();
    Usage::try_deserialize(&mut acc.data.as_slice()).unwrap()
}

fn warp(svm: &mut LiteSVM, secs: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp += secs;
    svm.set_sysvar(&clock);
}

fn ix_initialize(authority: &Pubkey, mint: &Pubkey, limit: u64, window_secs: i64) -> Instruction {
    Instruction::new_with_bytes(
        id(),
        &instruction::Initialize { limit, window_secs }.data(),
        accounts::Initialize {
            authority: *authority,
            mint: *mint,
            config: config_pda(mint),
            extra_account_meta_list: meta_list_pda(mint),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn ix_set_limit(authority: &Pubkey, mint: &Pubkey, limit: u64, window_secs: i64) -> Instruction {
    Instruction::new_with_bytes(
        id(),
        &instruction::SetLimit { limit, window_secs }.data(),
        accounts::SetLimit {
            authority: *authority,
            config: config_pda(mint),
        }
        .to_account_metas(None),
    )
}

fn ix_open_usage(payer: &Pubkey, mint: &Pubkey, owner: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        id(),
        &instruction::OpenUsage { owner: *owner }.data(),
        accounts::OpenUsage {
            payer: *payer,
            config: config_pda(mint),
            usage: usage_pda(mint, owner),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

/// `transfer_checked` plus the accounts Token-2022 needs to call the hook:
/// the resolved extra accounts, the hook program and the ExtraAccountMetaList.
fn ix_transfer(
    mint: &Pubkey,
    from_owner: &Pubkey,
    signer: &Pubkey,
    to_owner: &Pubkey,
    amount: u64,
    usage: Pubkey,
) -> Instruction {
    let mut ix = spl_token_2022::instruction::transfer_checked(
        &TOKEN_2022,
        &ata(from_owner, mint),
        mint,
        &ata(to_owner, mint),
        signer,
        &[],
        amount,
        DECIMALS,
    )
    .unwrap();
    ix.accounts.extend([
        AccountMeta::new_readonly(config_pda(mint), false),
        AccountMeta::new(usage, false),
        AccountMeta::new_readonly(id(), false),
        AccountMeta::new_readonly(meta_list_pda(mint), false),
    ]);
    ix
}

fn transfer(
    env: &mut Env,
    from: &Keypair,
    to: &Pubkey,
    amount: u64,
) -> Result<Vec<String>, String> {
    let ix = ix_transfer(
        &env.mint,
        &from.pubkey(),
        &from.pubkey(),
        to,
        amount,
        usage_pda(&env.mint, &from.pubkey()),
    );
    let from = from.insecure_clone();
    send(&mut env.svm, &[ix], &from, &[&from])
}

fn user(svm: &mut LiteSVM) -> Keypair {
    let kp = Keypair::new();
    svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
    kp
}

/// A Token-2022 mint with the transfer-hook extension pointing at our program,
/// a 100-token-per-day limit, ATAs for issuer/alice/bob, 1,000 tokens for alice
/// and the issuer, and a usage account for alice.
fn setup() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program(
        id(),
        include_bytes!("../../../target/deploy/transfer_limit_hook.so"),
    )
    .unwrap();
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = START;
    svm.set_sysvar(&clock);

    // Fixed keys: the same PDAs and bumps, so the same compute units, every run.
    let [issuer, alice, bob, mint_kp] = [1, 2, 3, 4].map(|n| Keypair::new_from_array([n; 32]));
    for kp in [&issuer, &alice, &bob] {
        svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
    }
    let mint = mint_kp.pubkey();
    let space =
        ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::TransferHook]).unwrap();
    let ixs = [
        create_account(
            &issuer.pubkey(),
            &mint,
            svm.minimum_balance_for_rent_exemption(space),
            space as u64,
            &TOKEN_2022,
        ),
        hook_extension::instruction::initialize(
            &TOKEN_2022,
            &mint,
            Some(issuer.pubkey()),
            Some(id()),
        )
        .unwrap(),
        spl_token_2022::instruction::initialize_mint2(
            &TOKEN_2022,
            &mint,
            &issuer.pubkey(),
            None,
            DECIMALS,
        )
        .unwrap(),
    ];
    send(&mut svm, &ixs, &issuer, &[&issuer, &mint_kp]).unwrap();

    let mut ixs = vec![];
    for owner in [&issuer, &alice, &bob] {
        ixs.push(create_associated_token_account(
            &issuer.pubkey(),
            &owner.pubkey(),
            &mint,
            &TOKEN_2022,
        ));
    }
    for owner in [&issuer, &alice] {
        ixs.push(
            spl_token_2022::instruction::mint_to(
                &TOKEN_2022,
                &mint,
                &ata(&owner.pubkey(), &mint),
                &issuer.pubkey(),
                &[],
                1_000 * UNIT,
            )
            .unwrap(),
        );
    }
    ixs.push(ix_initialize(&issuer.pubkey(), &mint, LIMIT, DAY));
    ixs.push(ix_open_usage(&issuer.pubkey(), &mint, &alice.pubkey()));
    send(&mut svm, &ixs, &issuer, &[&issuer]).unwrap();

    Env {
        svm,
        issuer,
        alice,
        bob,
        mint,
    }
}

fn assert_err(res: Result<Vec<String>, String>, needle: &str) {
    let logs = res.expect_err("expected the transaction to fail");
    assert!(logs.contains(needle), "expected `{needle}` in:\n{logs}");
}

#[test]
fn transfers_within_the_limit_succeed_and_are_counted() {
    let mut env = setup();
    let (alice, bob) = (env.alice.insecure_clone(), env.bob.pubkey());
    transfer(&mut env, &alice, &bob, 60 * UNIT).unwrap();
    transfer(&mut env, &alice, &bob, 40 * UNIT).unwrap();
    let u = usage(&env, &alice.pubkey());
    assert_eq!((u.used, u.window_start), (LIMIT, START));
    assert_eq!(balance(&env.svm, &bob, &env.mint), LIMIT);
}

#[test]
fn going_over_the_limit_fails_and_moves_nothing() {
    let mut env = setup();
    let (alice, bob) = (env.alice.insecure_clone(), env.bob.pubkey());
    transfer(&mut env, &alice, &bob, LIMIT).unwrap();
    assert_err(transfer(&mut env, &alice, &bob, 1), "LimitExceeded");
    assert_eq!(balance(&env.svm, &bob, &env.mint), LIMIT);
    assert_eq!(usage(&env, &alice.pubkey()).used, LIMIT);

    // A single transfer bigger than the limit fails too.
    let mut env = setup();
    let (alice, bob) = (env.alice.insecure_clone(), env.bob.pubkey());
    assert_err(transfer(&mut env, &alice, &bob, LIMIT + 1), "LimitExceeded");
}

#[test]
fn the_window_rolls_over() {
    let mut env = setup();
    let (alice, bob) = (env.alice.insecure_clone(), env.bob.pubkey());
    transfer(&mut env, &alice, &bob, LIMIT).unwrap();

    warp(&mut env.svm, DAY - 1);
    assert_err(transfer(&mut env, &alice, &bob, 1), "LimitExceeded");

    warp(&mut env.svm, 1);
    transfer(&mut env, &alice, &bob, LIMIT).unwrap();
    let u = usage(&env, &alice.pubkey());
    assert_eq!((u.used, u.window_start), (LIMIT, START + DAY));
}

#[test]
fn delegated_transfers_count_against_the_owner() {
    let mut env = setup();
    let (alice, bob) = (env.alice.insecure_clone(), env.bob.pubkey());
    let delegate = user(&mut env.svm);
    let approve = spl_token_2022::instruction::approve(
        &TOKEN_2022,
        &ata(&alice.pubkey(), &env.mint),
        &delegate.pubkey(),
        &alice.pubkey(),
        &[],
        1_000 * UNIT,
    )
    .unwrap();
    send(&mut env.svm, &[approve], &alice, &[&alice]).unwrap();

    // The delegate signs, but the usage account is Alice's.
    let ix = ix_transfer(
        &env.mint,
        &alice.pubkey(),
        &delegate.pubkey(),
        &bob,
        80 * UNIT,
        usage_pda(&env.mint, &alice.pubkey()),
    );
    send(&mut env.svm, &[ix], &delegate, &[&delegate]).unwrap();
    assert_eq!(usage(&env, &alice.pubkey()).used, 80 * UNIT);

    // Alice herself now only has 20 left.
    assert_err(transfer(&mut env, &alice, &bob, 21 * UNIT), "LimitExceeded");

    // Keying usage by the signer would let a fresh delegate start from zero.
    // Token-2022 derives the usage PDA from the source account's owner, so a
    // delegate-keyed account is rejected.
    send(
        &mut env.svm,
        &[ix_open_usage(
            &env.issuer.pubkey(),
            &env.mint,
            &delegate.pubkey(),
        )],
        &env.issuer,
        &[&env.issuer],
    )
    .unwrap();
    let ix = ix_transfer(
        &env.mint,
        &alice.pubkey(),
        &delegate.pubkey(),
        &bob,
        50 * UNIT,
        usage_pda(&env.mint, &delegate.pubkey()),
    );
    assert!(send(&mut env.svm, &[ix], &delegate, &[&delegate]).is_err());
}

#[test]
fn someone_elses_usage_account_is_rejected() {
    let mut env = setup();
    let (alice, bob) = (env.alice.insecure_clone(), env.bob.insecure_clone());
    send(
        &mut env.svm,
        &[ix_open_usage(&bob.pubkey(), &env.mint, &bob.pubkey())],
        &bob,
        &[&bob],
    )
    .unwrap();
    // Alice tries to spend from Bob's (empty) allowance.
    let ix = ix_transfer(
        &env.mint,
        &alice.pubkey(),
        &alice.pubkey(),
        &bob.pubkey(),
        50 * UNIT,
        usage_pda(&env.mint, &bob.pubkey()),
    );
    assert!(send(&mut env.svm, &[ix], &alice, &[&alice]).is_err());
    assert_eq!(usage(&env, &bob.pubkey()).used, 0);
}

#[test]
fn a_wallet_without_a_usage_account_cannot_send() {
    let mut env = setup();
    let (alice, bob) = (env.alice.insecure_clone(), env.bob.insecure_clone());
    transfer(&mut env, &alice, &bob.pubkey(), 10 * UNIT).unwrap();
    assert_err(
        transfer(&mut env, &bob, &alice.pubkey(), UNIT),
        "UsageNotOpened",
    );

    send(
        &mut env.svm,
        &[ix_open_usage(&bob.pubkey(), &env.mint, &bob.pubkey())],
        &bob,
        &[&bob],
    )
    .unwrap();
    transfer(&mut env, &bob, &alice.pubkey(), UNIT).unwrap();
}

#[test]
fn the_issuer_is_not_limited() {
    let mut env = setup();
    let (issuer, bob) = (env.issuer.insecure_clone(), env.bob.pubkey());
    transfer(&mut env, &issuer, &bob, 500 * UNIT).unwrap();
    assert_eq!(balance(&env.svm, &bob, &env.mint), 500 * UNIT);
    assert!(env
        .svm
        .get_account(&usage_pda(&env.mint, &issuer.pubkey()))
        .is_none());
}

#[test]
fn the_hook_cannot_be_called_directly() {
    let mut env = setup();
    let (alice, bob) = (env.alice.insecure_clone(), env.bob.pubkey());
    let mint = env.mint;
    let ix = Instruction::new_with_bytes(
        id(),
        &instruction::TransferHook { amount: LIMIT }.data(),
        accounts::TransferHook {
            source_token: ata(&alice.pubkey(), &mint),
            mint,
            destination_token: ata(&bob, &mint),
            authority: alice.pubkey(),
            extra_account_meta_list: meta_list_pda(&mint),
            config: config_pda(&mint),
            usage: usage_pda(&mint, &alice.pubkey()),
        }
        .to_account_metas(None),
    );
    // Even Alice can't burn her own allowance outside a transfer; a stranger
    // certainly can't.
    let mallory = user(&mut env.svm);
    assert_err(
        send(&mut env.svm, &[ix], &mallory, &[&mallory]),
        "NotTransferring",
    );
    assert_eq!(usage(&env, &alice.pubkey()).used, 0);
}

#[test]
fn transfers_without_the_hook_accounts_fail() {
    let mut env = setup();
    let (alice, bob) = (env.alice.insecure_clone(), env.bob.pubkey());
    let plain = spl_token_2022::instruction::transfer_checked(
        &TOKEN_2022,
        &ata(&alice.pubkey(), &env.mint),
        &env.mint,
        &ata(&bob, &env.mint),
        &alice.pubkey(),
        &[],
        UNIT,
        DECIMALS,
    )
    .unwrap();
    assert!(send(&mut env.svm, &[plain], &alice, &[&alice]).is_err());
}

#[test]
fn only_the_mint_authority_can_initialize() {
    let mut svm = LiteSVM::new();
    svm.add_program(
        id(),
        include_bytes!("../../../target/deploy/transfer_limit_hook.so"),
    )
    .unwrap();
    let (issuer, mallory) = (user(&mut svm), user(&mut svm));
    let mint_kp = Keypair::new();
    let mint = mint_kp.pubkey();
    let space =
        ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::TransferHook]).unwrap();
    let ixs = [
        create_account(
            &issuer.pubkey(),
            &mint,
            svm.minimum_balance_for_rent_exemption(space),
            space as u64,
            &TOKEN_2022,
        ),
        hook_extension::instruction::initialize(
            &TOKEN_2022,
            &mint,
            Some(issuer.pubkey()),
            Some(id()),
        )
        .unwrap(),
        spl_token_2022::instruction::initialize_mint2(
            &TOKEN_2022,
            &mint,
            &issuer.pubkey(),
            None,
            DECIMALS,
        )
        .unwrap(),
    ];
    send(&mut svm, &ixs, &issuer, &[&issuer, &mint_kp]).unwrap();

    // Mallory front-runs the issuer and tries to set a huge limit.
    assert_err(
        send(
            &mut svm,
            &[ix_initialize(&mallory.pubkey(), &mint, u64::MAX, 1)],
            &mallory,
            &[&mallory],
        ),
        "NotMintAuthority",
    );
    assert_err(
        send(
            &mut svm,
            &[ix_initialize(&issuer.pubkey(), &mint, 0, DAY)],
            &issuer,
            &[&issuer],
        ),
        "InvalidConfig",
    );
    send(
        &mut svm,
        &[ix_initialize(&issuer.pubkey(), &mint, LIMIT, DAY)],
        &issuer,
        &[&issuer],
    )
    .unwrap();
}

#[test]
fn only_the_authority_can_change_the_limit_and_it_applies_at_once() {
    let mut env = setup();
    let (alice, bob, issuer) = (
        env.alice.insecure_clone(),
        env.bob.pubkey(),
        env.issuer.insecure_clone(),
    );
    assert_err(
        send(
            &mut env.svm,
            &[ix_set_limit(&alice.pubkey(), &env.mint, u64::MAX, DAY)],
            &alice,
            &[&alice],
        ),
        "Unauthorized",
    );

    transfer(&mut env, &alice, &bob, 30 * UNIT).unwrap();
    send(
        &mut env.svm,
        &[ix_set_limit(&issuer.pubkey(), &env.mint, 40 * UNIT, DAY)],
        &issuer,
        &[&issuer],
    )
    .unwrap();
    assert_err(transfer(&mut env, &alice, &bob, 11 * UNIT), "LimitExceeded");
    transfer(&mut env, &alice, &bob, 10 * UNIT).unwrap();
}

/// Sends one instruction that must succeed; returns the transaction's compute units.
fn compute_units(svm: &mut LiteSVM, ix: Instruction, signer: &Keypair) -> u64 {
    let msg = Message::new_with_blockhash(&[ix], Some(&signer.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
    let meta = svm
        .send_transaction(tx)
        .unwrap_or_else(|e| panic!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
    // Per-program breakdown: shows the hook's own share of a transfer.
    for line in meta.logs.iter().filter(|l| l.contains("consumed")) {
        println!("  {line}");
    }
    svm.expire_blockhash();
    meta.compute_units_consumed
}

/// Writes `target/cu-report.json` for the compute-unit check in CI.
fn write_cu_report(rows: &[(String, u64)]) {
    let body: Vec<String> = rows
        .iter()
        .map(|(n, cu)| format!("  \"{n}\": {cu}"))
        .collect();
    let json = format!("{{\n{}\n}}\n", body.join(",\n"));
    let path = concat!(env!("CARGO_TARGET_TMPDIR"), "/../cu-report.json");
    std::fs::write(path, &json).unwrap();
    println!("{json}");
}

/// `cargo test cu_report -- --nocapture` prints whole-transaction compute units.
#[test]
fn cu_report() {
    let mut env = setup();
    let (alice, issuer) = (env.alice.insecure_clone(), env.issuer.insecure_clone());
    let (a, i, bob, mint) = (alice.pubkey(), issuer.pubkey(), env.bob.pubkey(), env.mint);
    let steps = [
        (
            "transfer (limited wallet)",
            ix_transfer(&mint, &a, &a, &bob, UNIT, usage_pda(&mint, &a)),
            &alice,
        ),
        (
            "transfer (exempt issuer)",
            ix_transfer(&mint, &i, &i, &bob, UNIT, usage_pda(&mint, &i)),
            &issuer,
        ),
        ("open_usage", ix_open_usage(&i, &mint, &bob), &issuer),
        (
            "set_limit",
            ix_set_limit(&i, &mint, 2 * LIMIT, DAY),
            &issuer,
        ),
    ];
    let rows =
        steps.map(|(name, ix, signer)| (name.to_string(), compute_units(&mut env.svm, ix, signer)));
    write_cu_report(&rows);
}
