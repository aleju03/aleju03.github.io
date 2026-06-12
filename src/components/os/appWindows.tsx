import { email } from '../../data/projects'
import { sounds } from './sounds'

/*
  The classic mail composer. Chat Rooms falls back to it when no chat server
  is configured, so there is always a way to reach me from inside the OS.
*/

const inset =
  'rounded-sm border border-stone-400 bg-white px-2 py-1 text-xs text-stone-700 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]'

export function ContactApp() {
  const field = `${inset} w-full focus-visible:border-blue-600`
  return (
    <form
      className="flex h-full flex-col gap-3 bg-stone-100 p-4"
      onSubmit={(e) => {
        e.preventDefault()
        const data = new FormData(e.currentTarget)
        const subject = encodeURIComponent(String(data.get('subject') ?? ''))
        const body = encodeURIComponent(String(data.get('body') ?? ''))
        sounds.open()
        location.href = `mailto:${email}?subject=${subject}&body=${body}`
      }}
    >
      <label className="flex items-center gap-3 text-xs text-stone-600">
        <span className="w-14">To</span>
        <input readOnly value={email} aria-label="To" className={`${field} bg-stone-50`} tabIndex={-1} />
      </label>
      <label className="flex items-center gap-3 text-xs text-stone-600">
        <span className="w-14">Subject</span>
        <input
          name="subject"
          data-no-focus-ring
          defaultValue="Hey Alejandro"
          aria-label="Subject"
          className={field}
        />
      </label>
      <textarea
        name="body"
        data-no-focus-ring
        placeholder="Write your message..."
        aria-label="Message"
        className={`${field} min-h-0 flex-1 resize-none py-2`}
      />
      <div className="flex justify-end">
        <button
          type="submit"
          className="cursor-pointer rounded-sm border border-stone-400 bg-stone-200 px-5 py-1.5 text-xs font-medium text-stone-800 shadow-[0_1px_0_rgba(255,255,255,0.8)_inset] transition active:scale-[0.98] hover:border-blue-600 hover:bg-stone-50"
        >
          Send
        </button>
      </div>
    </form>
  )
}
