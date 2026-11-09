export function Logo({ compact = false }) {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect width="32" height="32" rx="7" className="fill-brand-600" />
        <path d="M7 21h12v-9h4l3 4v5h-2" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx="11" cy="22.5" r="2" fill="#f59e0b" />
        <circle cx="22" cy="22.5" r="2" fill="#f59e0b" />
      </svg>
      {!compact && <span className="text-[15px]">Dispatch<span className="text-brand-600 dark:text-brand-300">Desk</span></span>}
    </span>
  );
}
