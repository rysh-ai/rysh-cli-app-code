import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FaceTimeContact } from '../types/facetime'

export function FaceTimePanel({ onClose }: { onClose: () => void }) {
  const api = window.electronAPI?.facetime
  const [query, setQuery] = useState('')
  const [contacts, setContacts] = useState<FaceTimeContact[]>([])
  const [selected, setSelected] = useState<FaceTimeContact>()
  const [addressID, setAddressID] = useState('')
  const [offset, setOffset] = useState(0)
  const [next, setNext] = useState<number>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('Allow Contacts access when macOS asks. Calls open in FaceTime on this Mac.')
  const [ready, setReady] = useState(false)
  const pending = useRef(false)
  const alive = useRef(true)
  const dialog = useRef<HTMLDialogElement>(null)
  const address = selected?.addresses.find((a) => a.id === addressID)

  useEffect(() => {
    alive.current = true
    dialog.current?.showModal()
    window.electronAPI?.webPane?.setSuppressed?.(true)
    return () => { alive.current = false; void api?.cancel().catch(() => {}); window.electronAPI?.webPane?.setSuppressed?.(false) }
  }, [api])

  async function load(page = 0) {
    if (!api || pending.current) return
    pending.current = true; setBusy(true); setContacts([]); setSelected(undefined); setAddressID(''); setNext(undefined)
    try {
      const result = await api.contacts(query, page)
      if (!alive.current) return
      setReady(true)
      if (result.error) setMessage(result.error)
      else {
        setContacts(result.contacts ?? []); setOffset(page); setNext(result.nextOffset)
        setMessage(result.contacts?.length ? 'Choose a contact, then a phone number or email.' : 'No contacts found.')
      }
    } catch { if (alive.current) setMessage('Could not load contacts. Check macOS Contacts permission and retry.') }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  async function call() {
    if (!api || !selected || !address || pending.current) return
    pending.current = true; setBusy(true); setMessage('Confirm the recipient in the macOS dialog.')
    try {
      const result = await api.call(selected.id, address.id, address.value)
      if (!alive.current) return
      if (result.error) { setContacts([]); setSelected(undefined); setAddressID(''); setMessage(result.error) }
      else setMessage(result.opened ? 'Opened FaceTime audio. Use the Apple call window for controls.' : 'Call canceled.')
    } catch { if (alive.current) {setContacts([]);setSelected(undefined);setMessage('Could not open FaceTime. Refresh contacts and retry.')} }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  return createPortal(
    <dialog ref={dialog} onCancel={(event) => { event.preventDefault(); onClose() }}
      aria-labelledby="facetime-title"
      className="w-[620px] max-w-[95vw] max-h-[85vh] bg-[#202020] text-[#eee] border border-[#555] rounded-lg p-5 backdrop:bg-black/60"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <div className="flex justify-between mb-4">
        <h2 id="facetime-title" className="text-lg">FaceTime audio — this Mac</h2>
        <button onClick={onClose} aria-label="Close FaceTime">✕</button>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); void load() }} className="flex gap-2 mb-3">
        <input aria-label="Search contacts" value={query} disabled={busy} onChange={(e) => setQuery(e.target.value)}
          maxLength={256} placeholder="Search contacts" className="flex-1 min-w-0 bg-[#111] border border-[#666] p-2 rounded" />
        <button disabled={busy || !api} className="border border-[#777] rounded p-2 disabled:opacity-50">
          {ready ? 'Search / refresh' : 'Load contacts'}
        </button>
      </form>
      <p role="status" className="text-sm mb-3">{busy ? 'Working… ' : ''}{message}</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="max-h-[40vh] overflow-y-auto" aria-label="Contacts">
          {contacts.map((c) => <button key={c.id} disabled={busy} onClick={() => { setSelected(c); setAddressID('') }}
            aria-pressed={selected?.id === c.id}
            className={`block w-full text-left rounded p-2 mb-1 ${selected?.id === c.id ? 'bg-[#005f5f]' : 'bg-[#303030]'}`}>
            {c.name}<span className="block text-xs text-[#bbb]">{c.addresses.length} addresses</span>
          </button>)}
        </div>
        <div>
          {selected && <>
            <h3 className="mb-2">{selected.name}</h3>
            {!selected.addresses.length && <p>No phone numbers or emails.</p>}
            <fieldset disabled={busy}>
              <legend className="text-sm">Choose an address</legend>
              {selected.addresses.map((a) => <label key={a.id} className="block my-2 break-all">
                <input type="radio" name="facetime-address" checked={addressID === a.id}
                  onChange={() => setAddressID(a.id)} /> {a.label}: {a.value}
              </label>)}
            </fieldset>
            <button disabled={busy || !address} onClick={() => void call()}
              className="bg-[#005f5f] rounded p-2 disabled:opacity-40">Call audio</button>
          </>}
        </div>
      </div>
      <div className="flex gap-4 mt-3">
        <button disabled={busy || offset === 0} onClick={() => void load(Math.max(0, offset - 50))}>Previous page</button>
        <button disabled={busy || next === undefined} onClick={() => void load(next)}>Next page</button>
      </div>
      <p className="text-xs text-[#bbb] mt-3">Contacts stay on this Mac. Apple’s FaceTime or Phone app handles sound and ending the call.</p>
    </dialog>, document.body)
}
