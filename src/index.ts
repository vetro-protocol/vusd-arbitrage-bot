import "dotenv/config";
import {Keeper} from "./keeper";
import {loadConfig} from "./config";

async function main() {
  const config = loadConfig();
  // PRIVATE_KEY is read directly from env (never put in Config). Unset → dry-run mode.
  const keeper = new Keeper(config, process.env.PRIVATE_KEY);

  process.on("SIGINT", () => {
    keeper.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    keeper.stop();
    process.exit(0);
  });

  await keeper.start();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
