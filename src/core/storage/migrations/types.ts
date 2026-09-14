export interface Migration {
  name: string;
  statements: readonly string[];
  version: number;
}
