import { formatCoordinates } from "@/shared/geo/posterBounds";
import type { Coordinate } from "@/shared/geo/types";
import { APP_CREDIT_URL } from "@/core/config";
import {
  TEXT_DIMENSION_REFERENCE_PX,
  TEXT_CITY_Y_RATIO,
  TEXT_DIVIDER_Y_RATIO,
  TEXT_COUNTRY_Y_RATIO,
  TEXT_COORDS_Y_RATIO,
  TEXT_EDGE_MARGIN_RATIO,
  CITY_FONT_BASE_PX,
  COUNTRY_FONT_BASE_PX,
  COORDS_FONT_BASE_PX,
  ATTRIBUTION_FONT_BASE_PX,
  isLatinScript,
  formatCityLabel,
  computeCityFontScale,
  computeAttributionColor,
} from "@/features/poster/domain/textLayout";

/** Map data attribution drawn in the bottom-right corner of every export. */
export const DEFAULT_MAP_ATTRIBUTION = "\u00a9 OpenStreetMap contributors";

export interface PosterAttribution {
  /** The text; defaults to the OpenStreetMap notice. Never empty: ODbL requires it. */
  text?: string;
  /** Font size in px; defaults to the poster scale. */
  fontSizePx?: number;
  /** Text colour; defaults to the poster's computed attribution colour. */
  color?: string;
  /** When set, a solid box in this colour sits behind the text so it stays legible on any map. */
  backdrop?: string;
}

export function drawPosterText(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  theme: { ui?: { text?: string } },
  center: Coordinate,
  city: string,
  country: string,
  fontFamily: string | undefined,
  showPosterText: boolean,
  showOverlay: boolean,
  includeCredits: boolean = true,
  attribution: PosterAttribution = {},
): void {
  const textColor = theme.ui?.text || "#111111";
  const landColor = theme.map?.land || "#808080";
  const attributionColor = computeAttributionColor(textColor, landColor, showOverlay);
  const attributionAlpha = showOverlay ? 0.55 : 0.9;
  const titleFontFamily = fontFamily
    ? `"${fontFamily}", "Space Grotesk", sans-serif`
    : '"Space Grotesk", sans-serif';
  const bodyFontFamily = fontFamily
    ? `"${fontFamily}", "IBM Plex Mono", monospace`
    : '"IBM Plex Mono", monospace';

  const dimScale = Math.max(
    0.45,
    Math.min(width, height) / TEXT_DIMENSION_REFERENCE_PX,
  );
  const attributionFontSize = ATTRIBUTION_FONT_BASE_PX * dimScale;

  if (showPosterText) {
    const cityLabel = formatCityLabel(city);
    const cityFontSize = CITY_FONT_BASE_PX * dimScale * computeCityFontScale(city);

    const countryFontSize = COUNTRY_FONT_BASE_PX * dimScale;
    const coordinateFontSize = COORDS_FONT_BASE_PX * dimScale;
    const cityY = height * TEXT_CITY_Y_RATIO;
    const lineY = height * TEXT_DIVIDER_Y_RATIO;
    const countryY = height * TEXT_COUNTRY_Y_RATIO;
    const coordinatesY = height * TEXT_COORDS_Y_RATIO;

    ctx.fillStyle = textColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${cityFontSize}px ${titleFontFamily}`;
    ctx.fillText(cityLabel, width * 0.5, cityY);

    ctx.strokeStyle = textColor;
    ctx.lineWidth = 3 * dimScale;
    ctx.beginPath();
    ctx.moveTo(width * 0.4, lineY);
    ctx.lineTo(width * 0.6, lineY);
    ctx.stroke();

    ctx.font = `300 ${countryFontSize}px ${titleFontFamily}`;
    ctx.fillText(country.toUpperCase(), width * 0.5, countryY);

    ctx.globalAlpha = 0.75;
    ctx.font = `400 ${coordinateFontSize}px ${bodyFontFamily}`;
    ctx.fillText(
      formatCoordinates(center.lat, center.lon),
      width * 0.5,
      coordinatesY,
    );
    ctx.globalAlpha = 1;
  }

  // The attribution is shrunk to fit the image width rather than clipped:
  // on a small map image it must still be complete (ODbL / CC-BY).
  const attributionText = attribution.text?.trim() || DEFAULT_MAP_ATTRIBUTION;
  const margin = Math.min(width, height) * TEXT_EDGE_MARGIN_RATIO;
  let attributionSize = attribution.fontSizePx ?? attributionFontSize;
  ctx.font = `300 ${attributionSize}px ${bodyFontFamily}`;
  const maxTextWidth = width - margin * 4;
  const measured = ctx.measureText(attributionText).width;
  if (measured > maxTextWidth) {
    attributionSize = attributionSize * (maxTextWidth / measured);
    ctx.font = `300 ${attributionSize}px ${bodyFontFamily}`;
  }
  const attrRight = width - margin;
  const attrBottom = height - margin;
  if (attribution.backdrop) {
    const textWidth = ctx.measureText(attributionText).width;
    const padX = attributionSize * 0.5;
    const padY = attributionSize * 0.3;
    ctx.globalAlpha = 1;
    ctx.fillStyle = attribution.backdrop;
    ctx.fillRect(
      attrRight - textWidth - padX,
      attrBottom - attributionSize - padY,
      textWidth + padX * 2,
      attributionSize + padY * 2,
    );
  }
  ctx.fillStyle = attribution.color ?? attributionColor;
  ctx.globalAlpha = attribution.color ? 1 : attributionAlpha;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(attributionText, attrRight, attrBottom);
  ctx.globalAlpha = 1;

  // No credit line unless a credit URL is configured (this fork ships none).
  if (includeCredits && APP_CREDIT_URL) {
    ctx.fillStyle = attributionColor;
    ctx.globalAlpha = attributionAlpha;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.font = `300 ${attributionFontSize}px ${bodyFontFamily}`;
    ctx.fillText(
      `© ${APP_CREDIT_URL}`,
      width * TEXT_EDGE_MARGIN_RATIO,
      height * (1 - TEXT_EDGE_MARGIN_RATIO),
    );
    ctx.globalAlpha = 1;
  }
}
