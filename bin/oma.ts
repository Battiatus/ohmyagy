#!/usr/bin/env node
import { init } from '../src/index.js';

process.exitCode = await init();
