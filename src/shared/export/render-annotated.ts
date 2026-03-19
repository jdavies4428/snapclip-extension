import type { ClipRecord } from '../types/session';

async function blobToImageBitmap(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob);
}

export async function renderAnnotatedClipBlob(clip: ClipRecord, sourceImage: Blob): Promise<Blob> {
  const imageBitmap = await blobToImageBitmap(sourceImage);
  const canvas = document.createElement('canvas');
  canvas.width = imageBitmap.width;
  canvas.height = imageBitmap.height;

  const context = canvas.getContext('2d');
  if (!context) {
    imageBitmap.close();
    throw new Error('LLM Clip could not create a canvas context for annotation rendering.');
  }

  context.drawImage(imageBitmap, 0, 0, imageBitmap.width, imageBitmap.height);
  context.lineWidth = Math.max(3, Math.round(Math.max(imageBitmap.width, imageBitmap.height) * 0.004));
  context.lineJoin = 'round';
  context.lineCap = 'round';

  for (const annotation of clip.annotations) {
    if (annotation.kind === 'box') {
      const x = (annotation.x / 100) * imageBitmap.width;
      const y = (annotation.y / 100) * imageBitmap.height;
      const width = (annotation.width / 100) * imageBitmap.width;
      const height = (annotation.height / 100) * imageBitmap.height;

      context.strokeStyle = annotation.color;
      context.fillStyle = `${annotation.color}22`;
      context.strokeRect(x, y, width, height);
      context.fillRect(x, y, width, height);
      continue;
    }

    if (annotation.kind === 'arrow') {
      const startX = (annotation.startX / 100) * imageBitmap.width;
      const startY = (annotation.startY / 100) * imageBitmap.height;
      const endX = (annotation.endX / 100) * imageBitmap.width;
      const endY = (annotation.endY / 100) * imageBitmap.height;
      const angle = Math.atan2(endY - startY, endX - startX);
      const headLength = Math.max(14, context.lineWidth * 4);

      context.strokeStyle = annotation.color;
      context.beginPath();
      context.moveTo(startX, startY);
      context.lineTo(endX, endY);
      context.stroke();

      context.fillStyle = annotation.color;
      context.beginPath();
      context.moveTo(endX, endY);
      context.lineTo(
        endX - headLength * Math.cos(angle - Math.PI / 6),
        endY - headLength * Math.sin(angle - Math.PI / 6),
      );
      context.lineTo(
        endX - headLength * Math.cos(angle + Math.PI / 6),
        endY - headLength * Math.sin(angle + Math.PI / 6),
      );
      context.closePath();
      context.fill();
      continue;
    }

    const x = (annotation.x / 100) * imageBitmap.width;
    const y = (annotation.y / 100) * imageBitmap.height;
    context.font = `${Math.max(16, Math.round(imageBitmap.width * 0.024))}px "SF Pro Display", "Segoe UI", sans-serif`;
    context.fillStyle = annotation.color;
    context.strokeStyle = 'rgba(8, 15, 28, 0.85)';
    context.lineWidth = Math.max(4, Math.round(Math.max(imageBitmap.width, imageBitmap.height) * 0.006));
    context.strokeText(annotation.text, x, y);
    context.fillText(annotation.text, x, y);
  }

  imageBitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => resolve(value), 'image/png');
  });

  if (!blob) {
    throw new Error('LLM Clip could not render the annotated clip image.');
  }

  return blob;
}
