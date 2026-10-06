interface GeneralHeaderProps {
  onAboutOpen?: () => void;
}

/**
 * Neutral header. This fork carries none of upstream's name, logo or social
 * links (README, "Branding"); the About modal promoted upstream and is gone.
 */
export default function GeneralHeader(_props: GeneralHeaderProps) {
  return (
    <header className="general-header">
      <div className="desktop-brand">
        <div className="desktop-brand-copy brand-copy">
          <h1 className="desktop-brand-title">Map renderer</h1>
          <p className="desktop-brand-kicker app-kicker">
            Map images from OpenStreetMap data
          </p>
        </div>
      </div>
    </header>
  );
}
