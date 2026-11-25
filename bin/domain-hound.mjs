#!/usr/bin/env node
// Domain Hound MCP server over stdio. Runs locally and never buys a domain.
import { serve } from '../server.mjs';

await serve();
