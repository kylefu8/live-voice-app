"""Resize the approved logo into Android launcher resources (requires Pillow)."""
from pathlib import Path

from PIL import Image, ImageDraw

project = Path(__file__).resolve().parents[2]
resources = project / 'native/android/app/src/main/res'
icon = Image.open(project / 'design/logo-v1-icon.png').convert('RGBA')
mark = Image.open(project / 'design/logo-v1-mark.png').convert('RGBA')

for density, scale in [('mdpi', 1), ('hdpi', 1.5), ('xhdpi', 2),
                       ('xxhdpi', 3), ('xxxhdpi', 4)]:
    target = resources / f'mipmap-{density}'
    target.mkdir(parents=True, exist_ok=True)
    size = round(48 * scale)
    legacy = icon.resize((size, size), Image.Resampling.LANCZOS)
    legacy.save(target / 'ic_launcher.png')
    # Supersample the legacy circular mask for clean edges.
    circle = Image.new('L', (size * 4, size * 4))
    ImageDraw.Draw(circle).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    legacy.putalpha(circle.resize((size, size), Image.Resampling.LANCZOS))
    legacy.save(target / 'ic_launcher_round.png')
    foreground_size = round(108 * scale)
    mark.resize((foreground_size, foreground_size), Image.Resampling.LANCZOS).save(
        target / 'ic_launcher_foreground.png')

print('Generated launcher icons for five Android densities.')
