export class BenchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
