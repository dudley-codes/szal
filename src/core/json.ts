export type JsonErrorFactory = (message: string) => Error;

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const isUnsafeJsonKey = (key: string): boolean => UNSAFE_KEYS.has(key);

export const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const cloneJson = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;

// Accept only finite JSON values and reject keys that can mutate object prototypes.
export const assertSafeJsonValue = (
  value: unknown,
  path: string,
  createError: JsonErrorFactory,
): void => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertSafeJsonValue(item, `${path}[${String(index)}]`, createError);
    }
    return;
  }
  if (isJsonRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (isUnsafeJsonKey(key)) {
        throw createError(`${path}.${key} is not a safe configuration field.`);
      }
      assertSafeJsonValue(item, `${path}.${key}`, createError);
    }
    return;
  }
  throw createError(`${path} must contain only JSON values.`);
};
