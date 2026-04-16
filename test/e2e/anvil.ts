import { ChildProcess, spawn, execSync } from "child_process";

/** Anvil's default first account private key (used by Executor) */
export const ANVIL_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
/** Anvil's third account — used for admin ops (setPrice) to avoid nonce conflicts */
export const ANVIL_ADMIN_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
export const ANVIL_ACCOUNT_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const ANVIL_ACCOUNT_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

export interface DeployedAddresses {
  usdc: string;
  vusd: string;
  gateway: string;
  dex: string;
  morpho: string;
  arb: string;
  keeper: string;
  treasury: string;
}

let anvilProcess: ChildProcess | null = null;

export async function startAnvil(port = 8545): Promise<void> {
  return new Promise((resolve, reject) => {
    anvilProcess = spawn("anvil", ["--port", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => reject(new Error("Anvil startup timeout")), 15_000);

    anvilProcess.stdout?.on("data", (data: Buffer) => {
      if (data.toString().includes("Listening on")) {
        clearTimeout(timeout);
        resolve();
      }
    });

    anvilProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start Anvil: ${err.message}. Is foundry installed?`));
    });
  });
}

export function stopAnvil(): void {
  if (anvilProcess) {
    anvilProcess.kill("SIGTERM");
    anvilProcess = null;
  }
}

export function deployMocks(rpcUrl: string): DeployedAddresses {
  const output = execSync(
    `forge script script/DeployMocks.s.sol:DeployMocks ` +
      `--rpc-url ${rpcUrl} ` +
      `--private-key ${ANVIL_PRIVATE_KEY} ` +
      `--broadcast`,
    {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 30_000,
    },
  );

  // Parse JSON between sentinel markers
  const startMarker = "DEPLOYED_ADDRESSES_JSON_START";
  const endMarker = "DEPLOYED_ADDRESSES_JSON_END";
  const startIdx = output.indexOf(startMarker);
  const endIdx = output.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `Failed to parse deployed addresses from forge output.\n` +
        `Looking for markers "${startMarker}" and "${endMarker}".\n` +
        `Output:\n${output.slice(-2000)}`,
    );
  }

  const jsonStr = output.substring(startIdx + startMarker.length, endIdx).trim();
  return JSON.parse(jsonStr) as DeployedAddresses;
}
