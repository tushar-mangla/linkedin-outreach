
import { config } from 'dotenv';
import { resolve } from 'path';
import { execa } from 'execa';

config({ path: resolve(process.cwd(), '.env') });

async function main() {
  await execa('npx', ['drizzle-kit', 'push'], {
    stdio: 'inherit',
    env: {
      DATABASE_URL: process.env.DATABASE_URL,
    },
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
