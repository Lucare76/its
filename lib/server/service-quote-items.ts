export type ServiceQuoteItemInput = {
  item_type: "service" | "free_text";
  title?: string | null;
  description?: string | null;
  service_type?: string | null;
  direction?: "arrival" | "departure" | "round_trip" | null;
  arrival_date?: string | null;
  arrival_time?: string | null;
  arrival_flight_train?: string | null;
  departure_date?: string | null;
  departure_time?: string | null;
  departure_flight_train?: string | null;
  hotel_name?: string | null;
  hotel_address?: string | null;
  pax?: number | null;
  quantity?: number | null;
  luggage_notes?: string | null;
  special_requests?: string | null;
  unit_price_cents?: number | null;
  total_price_cents?: number | null;
  price_notes?: string | null;
};

export type ServiceQuoteItem = ServiceQuoteItemInput & {
  id?: string;
  tenant_id?: string;
  quote_id?: string;
  sort_order: number;
  pax: number;
  quantity: number;
  unit_price_cents: number;
  total_price_cents: number;
};

type LegacyQuote = {
  service_type: string;
  direction: "arrival" | "departure" | "round_trip" | null;
  arrival_date: string | null;
  arrival_time: string | null;
  arrival_flight_train: string | null;
  departure_date: string | null;
  departure_time: string | null;
  departure_flight_train: string | null;
  hotel_name: string | null;
  hotel_address: string | null;
  pax: number;
  luggage_notes: string | null;
  special_requests: string | null;
  price_cents: number;
  price_notes: string | null;
};

function cleanText(value: string | null | undefined) {
  const text = value?.trim();
  return text ? text : null;
}

export function legacyQuoteToItem(quote: LegacyQuote): ServiceQuoteItem {
  const pax = Math.max(Number(quote.pax ?? 1), 1);
  const unitPrice = Math.max(Number(quote.price_cents ?? 0), 0);
  return {
    item_type: "service",
    sort_order: 0,
    title: null,
    description: null,
    service_type: quote.service_type,
    direction: quote.direction ?? null,
    arrival_date: quote.arrival_date ?? null,
    arrival_time: quote.arrival_time ?? null,
    arrival_flight_train: quote.arrival_flight_train ?? null,
    departure_date: quote.departure_date ?? null,
    departure_time: quote.departure_time ?? null,
    departure_flight_train: quote.departure_flight_train ?? null,
    hotel_name: quote.hotel_name ?? null,
    hotel_address: quote.hotel_address ?? null,
    pax,
    quantity: 1,
    luggage_notes: quote.luggage_notes ?? null,
    special_requests: quote.special_requests ?? null,
    unit_price_cents: unitPrice,
    total_price_cents: unitPrice * pax,
    price_notes: quote.price_notes ?? null,
  };
}

export function normalizeQuoteItems(items: ServiceQuoteItemInput[], legacyQuote?: LegacyQuote): ServiceQuoteItem[] {
  const source = items.length > 0 ? items : legacyQuote ? [legacyQuoteToItem(legacyQuote)] : [];
  return source.map((item, index) => {
    const itemType = item.item_type === "free_text" ? "free_text" : "service";
    const pax = Math.max(Number(item.pax ?? (itemType === "service" ? 1 : 0)), 0);
    const quantity = Math.max(Number(item.quantity ?? 1), 1);
    const unitPrice = Math.max(Number(item.unit_price_cents ?? 0), 0);
    const computedTotal = itemType === "service" ? unitPrice * Math.max(pax, 1) : unitPrice * quantity;
    const totalPrice = Math.max(Number(item.total_price_cents ?? computedTotal), 0);

    return {
      item_type: itemType,
      sort_order: index,
      title: cleanText(item.title),
      description: cleanText(item.description),
      service_type: itemType === "service" ? cleanText(item.service_type) : null,
      direction: itemType === "service" ? item.direction ?? null : null,
      arrival_date: itemType === "service" ? item.arrival_date ?? null : null,
      arrival_time: itemType === "service" ? item.arrival_time ?? null : null,
      arrival_flight_train: itemType === "service" ? cleanText(item.arrival_flight_train) : null,
      departure_date: itemType === "service" ? item.departure_date ?? null : null,
      departure_time: itemType === "service" ? item.departure_time ?? null : null,
      departure_flight_train: itemType === "service" ? cleanText(item.departure_flight_train) : null,
      hotel_name: itemType === "service" ? cleanText(item.hotel_name) : null,
      hotel_address: itemType === "service" ? cleanText(item.hotel_address) : null,
      pax,
      quantity,
      luggage_notes: itemType === "service" ? cleanText(item.luggage_notes) : null,
      special_requests: itemType === "service" ? cleanText(item.special_requests) : null,
      unit_price_cents: unitPrice,
      total_price_cents: totalPrice,
      price_notes: cleanText(item.price_notes),
    };
  });
}

export function quoteItemsTotalCents(items: ServiceQuoteItem[]) {
  return items.reduce((sum, item) => sum + item.total_price_cents, 0);
}

export function quoteItemsForInsert(tenantId: string, quoteId: string, items: ServiceQuoteItem[]) {
  return items.map((item) => ({
    tenant_id: tenantId,
    quote_id: quoteId,
    sort_order: item.sort_order,
    item_type: item.item_type,
    title: item.title,
    description: item.description,
    service_type: item.service_type,
    direction: item.direction,
    arrival_date: item.arrival_date,
    arrival_time: item.arrival_time,
    arrival_flight_train: item.arrival_flight_train,
    departure_date: item.departure_date,
    departure_time: item.departure_time,
    departure_flight_train: item.departure_flight_train,
    hotel_name: item.hotel_name,
    hotel_address: item.hotel_address,
    pax: item.pax,
    quantity: item.quantity,
    luggage_notes: item.luggage_notes,
    special_requests: item.special_requests,
    unit_price_cents: item.unit_price_cents,
    total_price_cents: item.total_price_cents,
    price_notes: item.price_notes,
  }));
}
