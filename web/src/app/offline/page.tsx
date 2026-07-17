export const metadata = { title: "Offline" };

export default function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-brand-navy p-6 text-center text-white">
      <div className="mb-4 text-5xl">📴</div>
      <h1 className="text-xl font-bold">You&apos;re offline</h1>
      <p className="mt-2 max-w-sm text-sm text-slate-300">
        No signal right now. Open <b>Field Mode</b> — your route, jobs, notes, time, and photos are
        saved on this device and will sync automatically when you&apos;re back online.
      </p>
      <a href="/field" className="mt-6 rounded-lg bg-brand-blue px-5 py-3 text-sm font-semibold text-white">
        Go to Field Mode
      </a>
    </main>
  );
}
