import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from 'react'
import type { NodeRecord, VersionGraph } from '../../shared/ipc'

const ROW_H = 42
const COL_W = 54
const PAD = 14

export type VersionGraphPanelProps = {
  graph: VersionGraph
  currentNodeId: string
  branchName: (branchId: string) => string
  onJump: (nodeId: string) => void
  onDelete: (nodeId: string) => void
}

type PopoverState = {
  node: NodeRecord
  left: number
  top: number
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

export function VersionGraphPanel({
  graph,
  currentNodeId,
  branchName,
  onJump,
  onDelete
}: VersionGraphPanelProps): ReactElement {
  const [popover, setPopover] = useState<PopoverState | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const layout = useMemo(() => {
    const { nodes, branches, edges } = graph
    const sorted = [...nodes].sort((a, b) => b.createdAt - a.createdAt)
    const rowOf = new Map(sorted.map((n, i) => [n.id, i]))
    const branchOrder = [...branches].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    )
    const laneOf = new Map(branchOrder.map((b, i) => [b.id, i]))
    const w = Math.max(branchOrder.length * COL_W + PAD * 2, 120)
    const h = sorted.length * ROW_H + PAD * 2
    const pos = (nodeId: string): { x: number; y: number } => {
      const n = nodes.find((x) => x.id === nodeId)
      if (!n) return { x: PAD, y: PAD }
      const r = rowOf.get(nodeId) ?? 0
      const lane = laneOf.get(n.branchId) ?? 0
      return {
        x: PAD + lane * COL_W + COL_W / 2,
        y: PAD + r * ROW_H + ROW_H / 2
      }
    }
    const segments: Array<{ d: string; key: string }> = []
    for (const e of edges) {
      const p = pos(e.from)
      const c = pos(e.to)
      const midY = (p.y + c.y) / 2
      const d = `M ${p.x} ${p.y} L ${p.x} ${midY} L ${c.x} ${midY} L ${c.x} ${c.y}`
      segments.push({ d, key: `${e.from}-${e.to}` })
    }
    return { sorted, rowOf, laneOf, w, h, pos, segments }
  }, [graph])

  useEffect(() => {
    if (!popover) return
    const onDoc = (e: MouseEvent): void => {
      const t = e.target
      if (t instanceof Node && (t as Element).closest?.('.version-graph-popover'))
        return
      if (t instanceof Node && (t as Element).closest?.('.version-graph-node-hit'))
        return
      setPopover(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPopover(null)
    }
    document.addEventListener('mousedown', onDoc, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [popover])

  const placePopover = (node: NodeRecord, clientX: number, clientY: number): void => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const pw = 280
    const ph = 220
    setPopover({
      node,
      left: clamp(clientX + 8, 8, vw - pw - 8),
      top: clamp(clientY + 8, 8, vh - ph - 8)
    })
  }

  return (
    <div className="version-graph-panel" ref={wrapRef}>
      <div
        className="version-graph-scroll"
        style={{ minHeight: Math.min(layout.h, 360) }}
      >
        <div
          className="version-graph-canvas"
          style={{ width: layout.w, height: layout.h, position: 'relative' }}
        >
          <svg
            className="version-graph-svg"
            width={layout.w}
            height={layout.h}
            aria-hidden
          >
            {layout.segments.map((s) => (
              <path
                key={s.key}
                d={s.d}
                fill="none"
                stroke="var(--version-graph-line, #5c6370)"
                strokeWidth={2}
              />
            ))}
          </svg>
          {layout.sorted.map((n) => {
            const p = layout.pos(n.id)
            const tip = graph.branches.some((b) => b.tipNodeId === n.id)
            const current = n.id === currentNodeId
            return (
              <button
                key={n.id}
                type="button"
                className={[
                  'version-graph-node-hit',
                  current ? 'is-current' : '',
                  tip ? 'is-tip' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{
                  position: 'absolute',
                  left: p.x - 9,
                  top: p.y - 9,
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  padding: 0,
                  border: '2px solid var(--version-graph-ring, #c0c4ce)',
                  background: current
                    ? 'var(--version-graph-current, #4a9eff)'
                    : tip
                      ? 'var(--version-graph-tip, #7eb6ff)'
                      : 'var(--version-graph-dot, #3d4350)'
                }}
                title={n.label}
                aria-label={`版本 ${n.label}`}
                onClick={(e) => {
                  e.stopPropagation()
                  placePopover(n, e.clientX, e.clientY)
                }}
              />
            )
          })}
        </div>
      </div>
      {popover ? (
        <div
          className="version-graph-popover"
          style={{
            position: 'fixed',
            left: popover.left,
            top: popover.top,
            zIndex: 2000
          }}
          role="dialog"
          aria-label="版本节点详情"
        >
          <div className="version-graph-popover-title">{popover.node.label}</div>
          <div className="version-graph-popover-meta">
            <div>分支：{branchName(popover.node.branchId)}</div>
            <div>
              时间：{new Date(popover.node.createdAt).toLocaleString()}
            </div>
            <div className="version-graph-popover-mono">
              id：{popover.node.id.slice(0, 10)}…
            </div>
            <div>对话截取 seq：{popover.node.conversationCutSeq}</div>
          </div>
          <div className="version-graph-popover-actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                setPopover(null)
                onJump(popover.node.id)
              }}
            >
              跳转
            </button>
            {popover.node.parentId != null ? (
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setPopover(null)
                  onDelete(popover.node.id)
                }}
              >
                删除
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
