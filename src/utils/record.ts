export const prettyPrintJson = (value: any) => {
  if (value === null || value === undefined) return "null";

  const stringValue = String(value);
  try {
    const parsed = JSON.parse(stringValue);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return stringValue;
  }
};

export const getValueType = (value: any) => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return "json";
    } catch {
      return "string";
    }
  }
  return "object";
};
