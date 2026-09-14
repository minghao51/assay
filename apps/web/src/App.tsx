import { APP_NAME, NEXT_MILESTONE, SCAFFOLD_STATUS } from './lib/app'

export function App() {
  return (
    <main>
      <h1>{APP_NAME}</h1>
      <p>{SCAFFOLD_STATUS}</p>
      <p>
        Next: <strong>{NEXT_MILESTONE}</strong>
      </p>
      <p>
        Documentation lives in <code>docs/</code> — start with <code>docs/README.md</code>.
      </p>
    </main>
  )
}
