export default function Home() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-start justify-center px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-tight text-fg">
        JobMatch
      </h1>
      <p className="mt-3 max-w-xl text-base leading-7 text-fg-muted">
        Upload a resume, get an AI-powered strengths/weaknesses breakdown, and
        see how it matches against job descriptions.
      </p>
    </div>
  );
}
