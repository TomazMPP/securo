import { ICON_MAP, isEmoji } from '@/lib/category-icons'
import { Question } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'

const SIZES = {
  xs: { box: 'w-4 h-4 rounded', icon: 11 },
  sm: { box: 'w-6 h-6 rounded-md', icon: 15 },
  md: { box: 'w-8 h-8 rounded-lg', icon: 18 },
  lg: { box: 'w-10 h-10 rounded-xl', icon: 22 },
  xl: { box: 'w-11 h-11 rounded-xl', icon: 24 },
} as const

interface CategoryIconProps {
  icon: string | null | undefined
  color: string | null | undefined
  size?: keyof typeof SIZES
  className?: string
}

/**
 * A category's icon: the glyph in the category color over a soft tint of
 * the same color (duotone), instead of a white glyph on a solid fill — it
 * reads as the category at a glance without shouting in dense lists.
 */
export function CategoryIcon({ icon, color, size = 'md', className }: CategoryIconProps) {
  const { box, icon: iconSize } = SIZES[size]
  const tone = color || '#6B7280'
  const iconStr = icon || 'circle-help'
  const tint = { backgroundColor: `color-mix(in srgb, ${tone} 16%, transparent)` }

  // Emoji fallback for backward compatibility
  if (isEmoji(iconStr)) {
    return (
      <div className={cn(box, 'flex items-center justify-center shrink-0', className)} style={tint}>
        <span style={{ fontSize: iconSize - 4, lineHeight: 1 }}>{iconStr}</span>
      </div>
    )
  }

  const known = iconStr in ICON_MAP
  const Glyph = known ? ICON_MAP[iconStr] : Question

  return (
    <div
      className={cn(box, 'flex items-center justify-center shrink-0', className)}
      style={tint}
      data-icon={known ? iconStr : 'circle-help'}
    >
      <Glyph size={iconSize} color={tone} weight="duotone" aria-hidden />
    </div>
  )
}
