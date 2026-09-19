export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JevQuestion =
  | {
      type: "boolean";
      instructions?: JsonValue;
      criteria?: { true?: JsonValue; false?: JsonValue } | null;
    }
  | {
      type: "choice";
      instructions?: JsonValue;
      criteria: Record<string, JsonValue>;
    }
  | {
      type: "score";
      instructions?: JsonValue;
      criteria: JsonValue[];
    };

export interface JevRequest {
  state: JsonValue;
  questions: Record<string, JevQuestion>;
}

export type JevAnswer =
  | { result: boolean; probability: number }
  | { choice: string; probabilities: Record<string, number> }
  | { score: number; probabilities: Record<string, number> };

export interface JevUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export interface JevEvaluation {
  answers: Record<string, JevAnswer>;
  usage?: JevUsage;
}

export class JevInputError extends Error {
  override name = "JevInputError";
}

export class JevResponseError extends Error {
  override name = "JevResponseError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function requireJsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (!isJsonValue(value)) throw new JevInputError(`${path} must be JSON-compatible`);
}

function parseQuestion(value: unknown, name: string): JevQuestion {
  if (!isRecord(value)) throw new JevInputError(`Question "${name}" must be an object`);
  if (value.type !== "boolean" && value.type !== "choice" && value.type !== "score") {
    throw new JevInputError(`Question "${name}" must use one of: boolean, choice, score`);
  }

  if ("instructions" in value) requireJsonValue(value.instructions, `Question "${name}" instructions`);

  if (value.type === "boolean") {
    if ("criteria" in value && value.criteria !== null) {
      if (!isRecord(value.criteria)) {
        throw new JevInputError(`Question "${name}" boolean criteria must be an object`);
      }
      for (const key of Object.keys(value.criteria)) {
        if (key !== "true" && key !== "false") {
          throw new JevInputError(`Question "${name}" boolean criteria only supports true and false`);
        }
        requireJsonValue(value.criteria[key], `Question "${name}" criteria.${key}`);
      }
    }
    return value as JevQuestion;
  }

  if (value.type === "choice") {
    if (!isRecord(value.criteria) || Object.keys(value.criteria).length < 2) {
      throw new JevInputError(`Question "${name}" choice criteria must contain at least two options`);
    }
    if (Object.keys(value.criteria).length > 255) {
      throw new JevInputError(`Question "${name}" choice criteria cannot contain more than 255 options`);
    }
    for (const [key, criterion] of Object.entries(value.criteria)) {
      if (!key) throw new JevInputError(`Question "${name}" choice labels cannot be empty`);
      requireJsonValue(criterion, `Question "${name}" criteria.${key}`);
    }
    return value as JevQuestion;
  }

  if (!Array.isArray(value.criteria) || value.criteria.length < 2) {
    throw new JevInputError(`Question "${name}" score criteria must contain at least two levels`);
  }
  if (value.criteria.length > 10) {
    throw new JevInputError(`Question "${name}" score criteria cannot contain more than 10 levels`);
  }
  value.criteria.forEach((criterion, index) => requireJsonValue(criterion, `Question "${name}" criteria[${index}]`));
  return value as JevQuestion;
}

export function parseJevRequest(value: unknown): JevRequest {
  if (!isRecord(value)) throw new JevInputError("Request must be an object");
  requireJsonValue(value.state, "state");
  if (!isRecord(value.questions) || Object.keys(value.questions).length === 0) {
    throw new JevInputError("At least one question is required");
  }

  const questions: Record<string, JevQuestion> = {};
  for (const [name, question] of Object.entries(value.questions)) {
    if (!name.trim()) throw new JevInputError("Question names cannot be empty");
    questions[name] = parseQuestion(question, name);
  }
  return { state: value.state, questions };
}

function parseProbability(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new JevResponseError(`${path} must be a probability between 0 and 1`);
  }
  return value;
}

function parseProbabilityMap(value: unknown, path: string): Record<string, number> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new JevResponseError(`${path} must be an object`);
  const probabilities: Record<string, number> = {};
  for (const [key, probability] of Object.entries(value)) {
    probabilities[key] = parseProbability(probability, `${path}.${key}`);
  }
  return probabilities;
}

function parseUsage(value: unknown): JevUsage | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new JevResponseError("usage must be an object");
  const usage: JevUsage = {};
  for (const [sourceKey, outputKey] of [["inputTokens", "input_tokens"], ["outputTokens", "output_tokens"]] as const) {
    const tokenCount = value[sourceKey];
    if (tokenCount === undefined) continue;
    if (typeof tokenCount !== "number" || !Number.isInteger(tokenCount) || tokenCount < 0) {
      throw new JevResponseError(`usage.${sourceKey} must be a non-negative integer`);
    }
    usage[outputKey] = tokenCount;
  }
  return usage;
}

export function normalizeGatewayResponse(
  value: unknown,
  questions: Record<string, JevQuestion>,
): JevEvaluation {
  if (!isRecord(value) || !isRecord(value.answers)) {
    throw new JevResponseError("response.answers must be an object");
  }

  const answers: Record<string, JevAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = value.answers[name];
    if (!isRecord(answer)) throw new JevResponseError(`missing answer for question "${name}"`);

    if (question.type === "boolean") {
      if (answer.type !== "boolean") {
        throw new JevResponseError(`answer for question "${name}" has the wrong type`);
      }
      const probability = parseProbability(answer.probability, `answers.${name}.probability`);
      answers[name] = {
        result: probability >= 0.5,
        probability,
      };
      continue;
    }

    if (question.type === "choice") {
      if (answer.type !== "choice" || typeof answer.choice !== "string") {
        throw new JevResponseError(`answer for question "${name}" has the wrong type`);
      }
      if (!Object.hasOwn(question.criteria, answer.choice)) {
        throw new JevResponseError(`answer for question "${name}" selected an unknown choice`);
      }
      answers[name] = {
        choice: answer.choice,
        probabilities: parseProbabilityMap(answer.probabilities, `answers.${name}.probabilities`),
      };
      continue;
    }

    if (answer.type !== "score" || typeof answer.score !== "number" || !Number.isFinite(answer.score)) {
      throw new JevResponseError(`answer for question "${name}" has the wrong type`);
    }
    answers[name] = {
      score: answer.score,
      probabilities: parseProbabilityMap(answer.probabilities, `answers.${name}.probabilities`),
    };
  }

  return { answers, usage: parseUsage(value.usage) };
}
