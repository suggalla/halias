#!/usr/bin/env node
// The README's address table, written from the deployment rather than by hand.
//
// It was hand-maintained and drifted the moment Sepolia was redeployed: three addresses in
// the one place a reader is most likely to trust, pointing at contracts that no longer
// existed. Same failure the test counts had, and the same fix as gen-errors.mjs — generate
// it, and have something fail when it is stale.
//
// Between markers rather than by locating a table: the prose around it is written by hand
// and must survive regeneration untouched.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE   = dirname(fileURLToPath(import.meta.url));
const README = join(HERE, "..", "..", "..", "README.md");
const CONFIG = join(HERE, "..", "..", "deployments", "networks", "sepolia.json");

const START = "<!-- deployment:sepolia -->";
const END   = "<!-- /deployment:sepolia -->";

/// Every contract a reader might want to check, in the order they depend on each other.
const ROWS = [
  ["HaliasPool",            "pool"],
  ["HaliasRegistry",        "registry"],
  ["HaliasController",      "controller"],
  ["TransactVerifier",      "verifier"],
  ["TransactClaimVerifier", "claimVerifier"],
];

export function renderTable(cfg) {
  const link = (a) => `[\`${a}\`](https://sepolia.etherscan.io/address/${a}#code)`;
  return [
    "| | |",
    "|---|---|",
    ...ROWS.map(([label, key]) => `| ${label} | ${link(cfg[key])} |`),
  ].join("\n");
}

export function currentBlock() {
  const md = readFileSync(README, "utf8");
  const from = md.indexOf(START);
  const to   = md.indexOf(END);
  if (from === -1 || to === -1) throw new Error(`README is missing ${START} / ${END}`);
  return { md, from, to, body: md.slice(from + START.length, to).trim() };
}

export function expected() {
  return renderTable(JSON.parse(readFileSync(CONFIG, "utf8")));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { md, from, to, body } = currentBlock();
  const want = expected();
  if (body === want) {
    console.log("README addresses already match sepolia.json");
  } else {
    writeFileSync(README, `${md.slice(0, from + START.length)}\n${want}\n${md.slice(to)}`);
    console.log("Rewrote the README address table from sepolia.json");
  }
}
