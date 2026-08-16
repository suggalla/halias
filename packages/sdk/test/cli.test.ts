import { expect } from "chai";
import { execFileSync, spawnSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname_compat = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname_compat, "../dist/cli.js");

// Use spawnSync so we can inspect non-zero exits without throwing.
function run(...args: string[]): { stdout: string; stderr: string; status: number } {
  const env = { ...process.env, PRIVATE_KEY: "" };
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf-8", env });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

describe("cli", () => {
  it("prints usage with no command", () => {
    const { stdout, status } = run();
    expect(status).to.equal(0);
    expect(stdout).to.include("halias");
    expect(stdout).to.include("COMMANDS");
  });

  it("prints usage for --help", () => {
    const { stdout, status } = run("--help");
    expect(status).to.equal(0);
    expect(stdout).to.include("COMMANDS");
  });

  it("unknown command exits non-zero and prints usage", () => {
    const { stdout, stderr, status } = run("bogus");
    expect(status).to.not.equal(0);
    expect(stderr + stdout).to.include("Unknown command");
  });

  it("known commands require PRIVATE_KEY", () => {
    const { stderr, status } = run("balance");
    expect(status).to.not.equal(0);
    expect(stderr).to.include("PRIVATE_KEY");
  });
});
