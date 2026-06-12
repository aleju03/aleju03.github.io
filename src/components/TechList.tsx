export function TechList({ tech }: { tech: string[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 font-mono text-xs text-stone-500 dark:text-stone-400">
      {tech.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  )
}
