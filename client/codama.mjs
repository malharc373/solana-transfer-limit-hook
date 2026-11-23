// Generates a typed @solana/kit client from the Anchor IDL.
//   anchor build && npm run generate
import { readFileSync } from "node:fs";
import { createFromRoot } from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";

const idl = JSON.parse(readFileSync(new URL("../target/idl/transfer_limit_hook.json", import.meta.url), "utf8"));
const codama = createFromRoot(rootNodeFromAnchor(idl));
await codama.accept(
  renderVisitor(new URL(".", import.meta.url).pathname, { importExtension: "js", syncPackageJson: false }),
);
console.log("generated client/src/generated");
