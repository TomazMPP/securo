// frontend/src/components/page-header.tsx
interface PageHeaderProps {
  section: string
  title: string
  action?: React.ReactNode
}

export function PageHeader({ section, title, action }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
      <div>
        <p className="sr-only">{section}</p>
        <h1 className="text-[22px] font-bold text-foreground tracking-tight">{title}</h1>
      </div>
      {action}
    </div>
  )
}
