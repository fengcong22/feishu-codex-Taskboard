export function startAutomaticExecutionTestServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}>;
