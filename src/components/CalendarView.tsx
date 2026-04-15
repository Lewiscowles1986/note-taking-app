import { useState, useMemo } from 'react';
import type { Note } from '@/lib/db';
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Pencil,
  FilePlus2,
  Eye,
  X,
} from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';

interface CalendarViewProps {
  notes: Note[];
  onSelectNote: (noteId: number, mode: 'edit' | 'view') => void;
  onNewNote: () => void;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatDateLabel(dateKey: string): string {
  const d = new Date(dateKey + 'T12:00:00');
  return d.toLocaleDateString('default', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

interface NoteOnDay {
  note: Note;
  type: 'created' | 'edited';
}

export default function CalendarView({ notes, onSelectNote, onNewNote }: CalendarViewProps) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const prevMonth = () => setCurrentDate(new Date(year, month - 1, 1));
  const nextMonth = () => setCurrentDate(new Date(year, month + 1, 1));
  const goToday = () => setCurrentDate(new Date());

  const dayMap = useMemo(() => {
    const map = new Map<string, NoteOnDay[]>();

    const addEntry = (key: string, entry: NoteOnDay) => {
      const list = map.get(key) || [];
      if (!list.some((e) => e.note.id === entry.note.id)) {
        list.push(entry);
        map.set(key, list);
      }
    };

    for (const note of notes) {
      const createdKey = toDateKey(note.createdAt);
      addEntry(createdKey, { note, type: 'created' });

      if (note.editDates) {
        for (const dateStr of note.editDates) {
          if (dateStr !== createdKey) {
            addEntry(dateStr, { note, type: 'edited' });
          }
        }
      }
    }

    return map;
  }, [notes]);

  const firstDay = new Date(year, month, 1);
  const startDow = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  const cells: { day: number; month: number; year: number; isCurrentMonth: boolean }[] = [];

  for (let i = startDow - 1; i >= 0; i--) {
    const d = daysInPrevMonth - i;
    const m = month - 1;
    const y = m < 0 ? year - 1 : year;
    cells.push({ day: d, month: (m + 12) % 12, year: y, isCurrentMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, month, year, isCurrentMonth: true });
  }
  const remaining = 7 - (cells.length % 7);
  if (remaining < 7) {
    for (let d = 1; d <= remaining; d++) {
      const m = month + 1;
      const y = m > 11 ? year + 1 : year;
      cells.push({ day: d, month: m % 12, year: y, isCurrentMonth: false });
    }
  }

  const todayKey = toDateKey(new Date());
  const monthName = firstDay.toLocaleString('default', { month: 'long' });
  const rows = Math.ceil(cells.length / 7);
  const MAX_VISIBLE = 3;

  const selectedEntries = selectedDay ? dayMap.get(selectedDay) || [] : [];

  return (
    <div className="flex h-full bg-background">
      {/* Main calendar area */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card">
          <div className="flex items-center gap-2">
            <button
              onClick={prevMonth}
              className="p-1.5 rounded-md hover:bg-accent text-muted-foreground transition-colors"
            >
              <ChevronLeft size={18} />
            </button>
            <h2 className="text-lg font-semibold text-foreground min-w-[180px] text-center">
              {monthName} {year}
            </h2>
            <button
              onClick={nextMonth}
              className="p-1.5 rounded-md hover:bg-accent text-muted-foreground transition-colors"
            >
              <ChevronRight size={18} />
            </button>
            <button
              onClick={goToday}
              className="ml-2 px-3 py-1 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
            >
              Today
            </button>
          </div>
          <button
            onClick={onNewNote}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
          >
            <Plus size={14} />
            New Note
          </button>
        </div>

        {/* Weekday headers */}
        <div className="grid grid-cols-7 border-b border-border bg-muted/50">
          {WEEKDAYS.map((d) => (
            <div key={d} className="px-2 py-2 text-xs font-semibold text-muted-foreground text-center">
              {d}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        <div
          className="grid grid-cols-7 flex-1 overflow-y-auto"
          style={{ gridTemplateRows: `repeat(${rows}, minmax(80px, 1fr))` }}
        >
          {cells.map((cell, idx) => {
            const dateKey = `${cell.year}-${String(cell.month + 1).padStart(2, '0')}-${String(cell.day).padStart(2, '0')}`;
            const isToday = dateKey === todayKey;
            const entries = dayMap.get(dateKey) || [];
            const visibleEntries = entries.slice(0, MAX_VISIBLE);
            const hasMore = entries.length > MAX_VISIBLE;
            const isSelected = selectedDay === dateKey;

            return (
              <div
                key={idx}
                onClick={() => setSelectedDay(dateKey)}
                className={`border-b border-r border-border p-1 overflow-hidden flex flex-col min-h-[80px] cursor-pointer transition-colors ${
                  !cell.isCurrentMonth ? 'bg-muted/30' : ''
                } ${isSelected ? 'ring-2 ring-primary ring-inset bg-primary/5' : 'hover:bg-accent/30'}`}
              >
                {/* Day number */}
                <div className="flex items-center justify-between mb-0.5 shrink-0">
                  <span
                    className={`text-xs font-medium w-5 h-5 flex items-center justify-center rounded-full ${
                      isToday
                        ? 'bg-primary text-primary-foreground'
                        : cell.isCurrentMonth
                        ? 'text-foreground'
                        : 'text-muted-foreground/50'
                    }`}
                  >
                    {cell.day}
                  </span>
                  {entries.length > 0 && (
                    <span className="text-[9px] text-muted-foreground tabular-nums">
                      {entries.length}
                    </span>
                  )}
                </div>

                {/* Note pill previews — icon on left, title truncated */}
                <div className="flex-1 space-y-px min-h-0 overflow-hidden">
                  {visibleEntries.map((entry) => (
                    <div
                      key={`${entry.note.id}-${entry.type}`}
                      className="flex items-center gap-1 px-1 py-px rounded text-[10px] leading-tight truncate bg-accent/60 text-accent-foreground"
                    >
                      {entry.type === 'created' ? (
                        <FilePlus2 size={9} className="shrink-0 text-primary" />
                      ) : (
                        <Pencil size={9} className="shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">{entry.note.title || 'Untitled'}</span>
                    </div>
                  ))}
                  {hasMore && (
                    <div className="text-[9px] text-muted-foreground px-1">
                      +{entries.length - MAX_VISIBLE} more
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Day detail sidebar */}
      {selectedDay && (
        <div className="w-72 border-l border-border bg-card flex flex-col shrink-0">
          <div className="flex items-center justify-between px-3 py-3 border-b border-border">
            <h3 className="text-sm font-semibold text-foreground truncate">
              {formatDateLabel(selectedDay)}
            </h3>
            <button
              onClick={() => setSelectedDay(null)}
              className="p-1 rounded-md hover:bg-accent text-muted-foreground"
            >
              <X size={14} />
            </button>
          </div>

          <ScrollArea className="flex-1">
            <div className="p-3 space-y-2">
              {selectedEntries.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">No notes on this day</p>
              ) : (
                selectedEntries.map((entry) => (
                  <div
                    key={`${entry.note.id}-${entry.type}`}
                    className="group rounded-lg border border-border bg-background p-2.5 space-y-1"
                  >
                    <div className="flex items-start gap-2">
                      {entry.type === 'created' ? (
                        <FilePlus2 size={12} className="shrink-0 mt-0.5 text-primary" />
                      ) : (
                        <Pencil size={12} className="shrink-0 mt-0.5 text-muted-foreground" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {entry.note.title || 'Untitled'}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {entry.type === 'created' ? 'Created' : 'Edited'}
                          {entry.note.category !== 'General' && ` · ${entry.note.category}`}
                        </p>
                      </div>
                    </div>
                    {entry.note.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 pl-5">
                        {entry.note.tags.slice(0, 3).map((t) => (
                          <span key={t} className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-1 pl-5 pt-1">
                      <button
                        onClick={() => onSelectNote(entry.note.id!, 'view')}
                        className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-accent hover:bg-accent/80 text-accent-foreground transition-colors"
                      >
                        <Eye size={10} /> View
                      </button>
                      <button
                        onClick={() => onSelectNote(entry.note.id!, 'edit')}
                        className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-accent hover:bg-accent/80 text-accent-foreground transition-colors"
                      >
                        <Pencil size={10} /> Edit
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
