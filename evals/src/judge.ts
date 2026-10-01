import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { LlmProvider, LlmUsage } from '../../apps/server/src/lib/llm/index.js';
import {
  correctnessVerdictSchema,
  faithfulnessVerdictSchema,
  type CorrectnessVerdict,
  type FaithfulnessVerdict,
} from './answers.js';

const judgesDir = fileURLToPath(new URL('../judges/', import.meta.url));

/** The fixed judge prompts (test plan §6.4), sent as each call's static instructions. */
export async function readJudgePrompts() {
  const [faithfulness, correctness] = await Promise.all([
    readFile(`${judgesDir}faithfulness.md`, 'utf8'),
    readFile(`${judgesDir}correctness.md`, 'utf8'),
  ]);
  return { faithfulness: faithfulness.trim(), correctness: correctness.trim() };
}

export type JudgePrompts = Awaited<ReturnType<typeof readJudgePrompts>>;

export interface CitedSource {
  marker: number;
  title: string;
  content: string;
}

export interface Judged<T> {
  verdict: T;
  usage: LlmUsage;
  model: string;
}

/** Splits the answer into claims and checks each against the sources it cites. */
export async function judgeFaithfulness(
  llm: LlmProvider,
  prompts: JudgePrompts,
  input: { question: string; answer: string; sources: CitedSource[] },
): Promise<Judged<FaithfulnessVerdict>> {
  const sources =
    input.sources.length === 0
      ? '(The answer cites no sources.)'
      : input.sources.map((s) => `[${s.marker}] ${s.title}\n${s.content}`).join('\n\n');
  const result = await llm.generateObject(
    {
      task: 'evalJudge',
      instructions: prompts.faithfulness,
      messages: [
        {
          role: 'user',
          content: `Question: ${input.question}\n\nSources:\n\n${sources}\n\n---\n\nAnswer:\n${input.answer}`,
        },
      ],
    },
    faithfulnessVerdictSchema,
  );
  return { verdict: result.object, usage: result.usage, model: result.model };
}

/** Scores the answer 1–5 against the expected answer. */
export async function judgeCorrectness(
  llm: LlmProvider,
  prompts: JudgePrompts,
  input: { question: string; expectedAnswer: string; answer: string },
): Promise<Judged<CorrectnessVerdict>> {
  const result = await llm.generateObject(
    {
      task: 'evalJudge',
      instructions: prompts.correctness,
      messages: [
        {
          role: 'user',
          content: `Question: ${input.question}\n\nExpected answer:\n${input.expectedAnswer}\n\n---\n\nAnswer to grade:\n${input.answer}`,
        },
      ],
    },
    correctnessVerdictSchema,
  );
  return { verdict: result.object, usage: result.usage, model: result.model };
}
