import { Contract } from '@algorandfoundation/algorand-typescript'

export class RetiReader extends Contract {
  hello(name: string): string {
    return `Hello, ${name}`
  }
}
