import { ref } from 'vue';

// Chrome enters "protected mode" during dragover and hides custom MIME types —
// only 'Files', 'text/plain', 'text/html', 'text/uri-list' are visible. So our
// sentinel `application/x-werkbank-todo` is invisible between dragstart and drop,
// which breaks preventDefault() in dragover handlers. This ref gives us a reliable
// in-app flag instead.

export const draggingCardId = ref<number | null>(null);

export function beginCardDrag(id: number) { draggingCardId.value = id; }
export function endCardDrag() { draggingCardId.value = null; }
export function isCardDragging(): boolean { return draggingCardId.value !== null; }
