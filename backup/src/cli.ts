#!/usr/bin/env node
/**
 * cli.ts – Command-line interface for DLMS backup/restore operations.
 *
 * Usage:
 *   npx dlms-backup backup [--label my-label]
 *   npx dlms-backup restore <s3-key> [--dry-run]
 *   npx dlms-backup reindex
 *   npx dlms-backup list
 */

import { Command } from "commander";
import { backup, restore, reindex, listBackups } from "./index";

const program = new Command();

program
  .name("dlms-backup")
  .description("DLMS Polyglot backup, restore and reindex utilities")
  .version("1.0.0");

program
  .command("backup")
  .description("Export PostgreSQL data to S3 as a compressed JSON backup")
  .option("-l, --label <label>", "Backup label / subfolder", "manual")
  .action(async (opts) => {
    try {
      const key = await backup(opts.label);
      console.log(`\n✅  Backup stored at: ${key}`);
    } catch (err: any) {
      console.error("Backup failed:", err.message);
      process.exit(1);
    }
  });

program
  .command("restore <s3Key>")
  .description("Restore PostgreSQL data from an S3 backup and reindex OpenSearch")
  .option("--dry-run", "Parse the backup and report without writing any data")
  .action(async (s3Key, opts) => {
    try {
      await restore(s3Key, opts.dryRun);
      console.log("\n✅  Restore complete");
    } catch (err: any) {
      console.error("Restore failed:", err.message);
      process.exit(1);
    }
  });

program
  .command("reindex")
  .description("Rebuild OpenSearch indexes from the current PostgreSQL data")
  .action(async () => {
    try {
      await reindex();
      console.log("\n✅  Reindex complete");
    } catch (err: any) {
      console.error("Reindex failed:", err.message);
      process.exit(1);
    }
  });

program
  .command("list")
  .description("List available S3 backups")
  .action(async () => {
    try {
      const keys = await listBackups();
      if (keys.length === 0) {
        console.log("No backups found.");
      } else {
        console.log(`\nAvailable backups (${keys.length}):`);
        keys.forEach((k) => console.log(`  ${k}`));
      }
    } catch (err: any) {
      console.error("List failed:", err.message);
      process.exit(1);
    }
  });

program.parse(process.argv);
