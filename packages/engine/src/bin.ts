#!/usr/bin/env node
import { startStdioEngine } from "./main.ts";

// Spawned by the CLI (or tests) as a child with stdio ["pipe", "pipe", "inherit"].
await startStdioEngine();
