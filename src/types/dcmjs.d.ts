declare module 'dcmjs' {
  export const data: {
    DicomMessage: {
      readFile(input: ArrayBuffer | SharedArrayBuffer): { dict: unknown }
    }
    DicomMetaDictionary: {
      naturalizeDataset(input: unknown): Record<string, unknown>
    }
  }
}
