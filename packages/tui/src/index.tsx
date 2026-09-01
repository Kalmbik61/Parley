#!/usr/bin/env node
import { buildIndex } from '@harnas/core';
import { render } from 'ink';
import { App } from './app.js';

// Читаем ~/.claude/projects строго на чтение — это юридическая граница проекта.
render(<App sessions={await buildIndex()} />);
