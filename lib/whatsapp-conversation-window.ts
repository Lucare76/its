export const WHATSAPP_CUSTOMER_CARE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type WhatsAppConversationWindowState = {
  isOpen: boolean;
  lastInboundAt: string | null;
  closesAt: string | null;
};

export function getWhatsAppConversationWindowState(
  lastInboundAt: string | null | undefined,
  now: Date = new Date(),
): WhatsAppConversationWindowState {
  if (!lastInboundAt) {
    return { isOpen: false, lastInboundAt: null, closesAt: null };
  }

  const inboundAt = new Date(lastInboundAt);
  const inboundTime = inboundAt.getTime();
  if (!Number.isFinite(inboundTime)) {
    return { isOpen: false, lastInboundAt: null, closesAt: null };
  }

  const closesAt = new Date(inboundTime + WHATSAPP_CUSTOMER_CARE_WINDOW_MS).toISOString();
  if (inboundTime > now.getTime()) {
    return { isOpen: true, lastInboundAt, closesAt };
  }

  return {
    isOpen: now.getTime() - inboundTime <= WHATSAPP_CUSTOMER_CARE_WINDOW_MS,
    lastInboundAt,
    closesAt,
  };
}

export function isWhatsAppConversationWindowOpen(
  lastInboundAt: string | null | undefined,
  now: Date = new Date(),
) {
  return getWhatsAppConversationWindowState(lastInboundAt, now).isOpen;
}
