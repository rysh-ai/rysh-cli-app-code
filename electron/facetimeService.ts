import type { FaceTimeReply } from '../src/types/facetime'

export interface FaceTimeRequest {
  version: 1
  operation: 'doctor' | 'contacts' | 'call'
  search?: string
  offset?: number
  limit?: number
  contactID?: string
  addressID?: string
  expectedValue?: string
}
export function contactsRequest(search: unknown, offset: unknown = 0): FaceTimeRequest {
  if (typeof search !== 'string' || Buffer.byteLength(search) > 256 ||
      typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 100000) {
    throw new Error('Invalid contact search or page.')
  }
  return { version: 1, operation: 'contacts', search, offset, limit: 50 }
}
export function callRequest(contactID: unknown, addressID: unknown, expectedValue: unknown): FaceTimeRequest {
  for (const v of [contactID, addressID, expectedValue]) {
    if (typeof v !== 'string' || !v || Buffer.byteLength(v) > 1024 || /[\u0000-\u001f\u007f]/.test(v)) {
      throw new Error('Choose a valid contact and address first.')
    }
  }
  return { version: 1, operation: 'call', contactID: contactID as string,
    addressID: addressID as string, expectedValue: expectedValue as string }
}
export function decodeReply(stdout: string): FaceTimeReply {
  const r = JSON.parse(stdout)
  if (!r || r.version !== 1 || (r.contacts !== undefined && !Array.isArray(r.contacts))) {
    throw new Error('Update the Rysh desktop app and sidecar together.')
  }
  return r
}
