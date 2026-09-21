import type { Operation } from '../config/types.js'


export class SecurityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecurityError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export type ViolationLayer = 1 | 2 | 3 | 4


export class ViolationError extends SecurityError {
  public readonly layer: ViolationLayer
  public readonly operation: Operation
  public readonly table?: string
  public readonly column?: string

  constructor(details: {
    message: string
    layer: ViolationLayer
    operation: Operation
    table?: string
    column?: string
  }) {
    super(details.message)
    this.name = 'ViolationError'
    this.layer = details.layer
    this.operation = details.operation
    this.table = details.table
    this.column = details.column
  }
}
