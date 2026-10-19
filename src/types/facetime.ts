export interface FaceTimeAddress { id: string; label: string; kind: 'phone' | 'email'; value: string }
export interface FaceTimeContact { id: string; name: string; addresses: FaceTimeAddress[] }
export interface FaceTimeReply {
  version: number
  permission?: string
  available?: boolean
  handler?: string
  contacts?: FaceTimeContact[]
  nextOffset?: number
  opened?: boolean
  error?: string
  code?: string
}
export interface FaceTimeAPI {
  doctor: () => Promise<FaceTimeReply>
  contacts: (search: string, offset?: number) => Promise<FaceTimeReply>
  call: (contactID: string, addressID: string, expectedValue: string) => Promise<FaceTimeReply>
  cancel: () => Promise<void>
}
