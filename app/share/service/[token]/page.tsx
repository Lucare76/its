import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatServiceDateTime, getSharedServiceByToken } from "@/lib/server/service-share";

interface ShareServicePageProps {
  params: Promise<{ token: string }>;
}

function appBaseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || "https://example.com";
}

function buildShareText(url: string, details: { dateTime: string; hotel: string; meetingPoint: string; vessel: string; pax: number }) {
  return [
    "Dettagli transfer Ischia:",
    `Data/Ora: ${details.dateTime}`,
    `Hotel: ${details.hotel}`,
    `Meeting point: ${details.meetingPoint}`,
    `Porto/Nave: ${details.vessel}`,
    `Pax: ${details.pax}`,
    `Link: ${url}`
  ].join("\n");
}

export async function generateMetadata({ params }: ShareServicePageProps): Promise<Metadata> {
  const { token } = await params;
  const service = await getSharedServiceByToken(token);
  const base = appBaseUrl();
  const url = `${base}/share/service/${token}`;

  if (!service) {
    return {
      title: "Link non disponibile | Ischia Transfer",
      description: "Questo link non e valido o e scaduto.",
      openGraph: {
        title: "Link non disponibile | Ischia Transfer",
        description: "Questo link non e valido o e scaduto.",
        url,
        type: "website",
        images: [`${base}/share/service/${token}/opengraph-image`]
      },
      twitter: {
        card: "summary_large_image",
        title: "Link non disponibile | Ischia Transfer",
        description: "Questo link non e valido o e scaduto.",
        images: [`${base}/share/service/${token}/opengraph-image`]
      }
    };
  }

  const dateTime = formatServiceDateTime(service.date, service.time);
  const title = `Transfer Ischia - ${dateTime}`;
  const description = `Da ${service.vessel} a ${service.hotel_name ?? "hotel"}${service.meeting_point ? `, meeting point: ${service.meeting_point}` : ""}.`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url,
      type: "website",
      images: [`${base}/share/service/${token}/opengraph-image`]
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${base}/share/service/${token}/opengraph-image`]
    }
  };
}

export default async function ShareServicePage({ params }: ShareServicePageProps) {
  const { token } = await params;
  const service = await getSharedServiceByToken(token);
  if (!service) notFound();

  const base = appBaseUrl();
  const shareUrl = `${base}/share/service/${token}`;
  const dateTime = formatServiceDateTime(service.date, service.time);
  const hotel = service.hotel_name ?? "Hotel da confermare";
  const meetingPoint = service.meeting_point ?? "Da confermare";
  const vessel = service.vessel ?? "Da confermare";
  const text = buildShareText(shareUrl, { dateTime, hotel, meetingPoint, vessel, pax: service.pax });
  const waHref = `https://wa.me/?text=${encodeURIComponent(text)}`;

  return (
    <section className="mx-auto max-w-xl space-y-4 py-4">
      <article className="card space-y-3 p-5">
        <p className="text-xs uppercase tracking-[0.16em] text-muted">Condivisione servizio</p>
        <h1 className="text-2xl font-semibold text-text">Transfer Ischia</h1>
        <div className="grid gap-2 text-sm text-text">
          <p>
            <span className="font-medium">Data/Ora:</span> {dateTime}
          </p>
          <p>
            <span className="font-medium">Hotel:</span> {hotel}
          </p>
          <p>
            <span className="font-medium">Meeting point:</span> {meetingPoint}
          </p>
          <p>
            <span className="font-medium">Porto/Nave:</span> {vessel}
          </p>
          <p>
            <span className="font-medium">Passeggeri:</span> {service.pax}
          </p>
          <p>
            <span className="font-medium">Assistenza:</span> +39 081 000 0000
          </p>
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          <a href={waHref} target="_blank" rel="noreferrer" className="btn-primary">
            Condividi su WhatsApp
          </a>
          <Link href={shareUrl} className="btn-secondary">
            Copia link
          </Link>
        </div>
      </article>
    </section>
  );
}

