/** Internal JSON Schema subset emitted by the pinned API export. */
export type Schema = {
  $ref?: string;
  type?: string;
  anyOf?: Schema[];
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  additionalProperties?: boolean | Schema;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  minimum?: number;
  maximum?: number;
  [key: string]: unknown;
};

/** Validate required fields and known shapes without stripping future properties. */
export function matches(value: unknown, schema: Schema, definitions: Record<string, Schema>): boolean {
  if (schema.$ref) {
    const target = definitions[schema.$ref.split("/").at(-1)!];
    return !!target && matches(value, target, definitions);
  }
  if (schema.anyOf) return schema.anyOf.some(branch => matches(value, branch, definitions));
  if (schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case "null": return value === null;
    case "string": return typeof value === "string"
      && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity);
    case "integer": case "number": return typeof value === "number" && Number.isFinite(value)
      && (schema.type !== "integer" || Number.isInteger(value))
      && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value) && value.length >= (schema.minItems ?? 0)
      && value.every(item => matches(item, schema.items ?? {}, definitions));
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      if (schema.required?.some(key => !Object.hasOwn(record, key))) return false;
      if (schema.additionalProperties && typeof schema.additionalProperties === "object"
        && Object.entries(record).some(([key, item]) => !Object.hasOwn(schema.properties ?? {}, key)
          && !matches(item, schema.additionalProperties as Schema, definitions))) return false;
      return Object.entries(schema.properties ?? {}).every(([key, child]) =>
        !Object.hasOwn(record, key) || matches(record[key], child, definitions));
    }
    default: return true;
  }
}
