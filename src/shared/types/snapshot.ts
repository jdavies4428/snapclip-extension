import { z } from 'zod';

export const viewportSchema = z.object({
  width: z.number(),
  height: z.number(),
  dpr: z.number(),
});

export const domSummarySchema = z.object({
  headings: z.array(z.string()),
  buttons: z.array(z.string()),
  fields: z.array(z.string()),
  selectedText: z.string().optional(),
});

export const screenshotSchema = z.object({
  dataUrl: z.string(),
  width: z.number(),
  height: z.number(),
  format: z.enum(['png', 'jpeg']),
});

export const pageContextSchema = z.object({
  title: z.string(),
  url: z.string(),
  viewport: viewportSchema,
  userAgent: z.string(),
  platform: z.string(),
  language: z.string(),
  timeZone: z.string(),
  domSummary: domSummarySchema,
});
export type PageContext = z.infer<typeof pageContextSchema>;
