<#
.SYNOPSIS
  Turn a supplied illustration into the pet sprite the window draws.

.DESCRIPTION
  The window needs a square image with a transparent background, and the source
  is neither. This crops a square around the subject, removes the background by
  flood-filling inward from the border (so dark pixels *inside* the character —
  eyes, outlines, the choker — survive, which a luminance key would destroy),
  feathers the anti-aliased rim, and writes a resized PNG.

  Written against System.Drawing so it needs no image tooling installed. The
  pixel work is C# compiled at run time rather than PowerShell loops, because a
  per-pixel pass over ~700k pixels in script is minutes, not seconds.

.EXAMPLE
  powershell -File tools/prepare-pet-image.ps1 -Source .\art\source.png
#>
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [string]$Out = '',
  [int]$Size = 448,
  # Where the subject sits in the source, as a fraction of width/height.
  [double]$CenterX = 0.46,
  [double]$CenterY = 0.5,
  # How dark a pixel must be to count as background.
  [int]$Threshold = 70
)

$ErrorActionPreference = 'Stop'

if ($Out -eq '') {
  $Out = Join-Path $PSScriptRoot '..\pet-app\public\pet.png'
}
$Out = [System.IO.Path]::GetFullPath($Out)

Add-Type -AssemblyName System.Drawing
# Windows PowerShell compiles the snippet against a minimal reference set, so
# System.Drawing has to be named explicitly for Drawing2D/Imaging to resolve.
Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class PetArt
{
    /// Crop a square around the subject, key out the border-connected
    /// background, feather the rim, then resize. Returns the size written.
    public static int[] Process(string source, string output, int size,
                                double centerX, double centerY, int threshold)
    {
        using (var original = new Bitmap(source))
        {
            int side = Math.Min(original.Width, original.Height);
            int cx = (int)Math.Round(original.Width * centerX);
            int cy = (int)Math.Round(original.Height * centerY);
            int left = Clamp(cx - side / 2, 0, original.Width - side);
            int top = Clamp(cy - side / 2, 0, original.Height - side);

            using (var cropped = new Bitmap(side, side, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(cropped))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.DrawImage(original, new Rectangle(0, 0, side, side),
                                new Rectangle(left, top, side, side), GraphicsUnit.Pixel);
                }

                KeyBackground(cropped, threshold);

                using (var scaled = new Bitmap(size, size, PixelFormat.Format32bppArgb))
                {
                    using (var g = Graphics.FromImage(scaled))
                    {
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        g.CompositingMode = CompositingMode.SourceCopy;
                        g.DrawImage(cropped, new Rectangle(0, 0, size, size));
                    }
                    scaled.Save(output, ImageFormat.Png);
                }
            }

            return new int[] { side, left, top };
        }
    }

    static int Clamp(int value, int low, int high)
    {
        return value < low ? low : (value > high ? high : value);
    }

    /// Flood fill inward from every border pixel that reads as background.
    /// Only pixels *connected to the edge* are removed, so a dark subject on a
    /// dark ground keeps its interior.
    static void KeyBackground(Bitmap bitmap, int threshold)
    {
        int width = bitmap.Width;
        int height = bitmap.Height;
        var rect = new Rectangle(0, 0, width, height);
        var data = bitmap.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        try
        {
            int stride = data.Stride;
            byte[] buffer = new byte[stride * height];
            Marshal.Copy(data.Scan0, buffer, 0, buffer.Length);

            int count = width * height;
            bool[] background = new bool[count];
            var stack = new Stack<int>();

            for (int x = 0; x < width; x++)
            {
                Push(stack, background, buffer, stride, x, 0, width, threshold);
                Push(stack, background, buffer, stride, x, height - 1, width, threshold);
            }
            for (int y = 0; y < height; y++)
            {
                Push(stack, background, buffer, stride, 0, y, width, threshold);
                Push(stack, background, buffer, stride, width - 1, y, width, threshold);
            }

            while (stack.Count > 0)
            {
                int index = stack.Pop();
                int x = index % width;
                int y = index / width;
                Push(stack, background, buffer, stride, x - 1, y, width, threshold);
                Push(stack, background, buffer, stride, x + 1, y, width, threshold);
                Push(stack, background, buffer, stride, x, y - 1, width, threshold);
                Push(stack, background, buffer, stride, x, y + 1, width, threshold);
            }

            // Feather: a pixel that touches removed background keeps an alpha
            // proportional to its brightness, which turns the anti-aliased rim
            // into a soft edge instead of a dark outline.
            for (int y = 0; y < height; y++)
            {
                for (int x = 0; x < width; x++)
                {
                    int index = y * width + x;
                    int at = y * stride + x * 4;
                    if (background[index])
                    {
                        buffer[at + 3] = 0;
                        continue;
                    }
                    if (!TouchesBackground(background, width, height, x, y)) continue;
                    int r = buffer[at + 2], g = buffer[at + 1], b = buffer[at];
                    int luminance = (r * 299 + g * 587 + b * 114) / 1000;
                    int alpha = luminance * 255 / threshold;
                    if (alpha > 255) alpha = 255;
                    if (alpha < buffer[at + 3]) buffer[at + 3] = (byte)alpha;
                }
            }

            Marshal.Copy(buffer, 0, data.Scan0, buffer.Length);
        }
        finally
        {
            bitmap.UnlockBits(data);
        }
    }

    static void Push(Stack<int> stack, bool[] background, byte[] buffer, int stride,
                     int x, int y, int width, int threshold)
    {
        if (x < 0 || y < 0 || x >= width) return;
        int index = y * width + x;
        if (index < 0 || index >= background.Length) return;
        if (background[index]) return;
        int at = y * stride + x * 4;
        int r = buffer[at + 2], g = buffer[at + 1], b = buffer[at];
        if (r > threshold || g > threshold || b > threshold) return;
        background[index] = true;
        stack.Push(index);
    }

    static bool TouchesBackground(bool[] background, int width, int height, int x, int y)
    {
        for (int dy = -1; dy <= 1; dy++)
        {
            for (int dx = -1; dx <= 1; dx++)
            {
                int nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                if (background[ny * width + nx]) return true;
            }
        }
        return false;
    }
}
'@

Write-Output "source: $Source"
$result = [PetArt]::Process($Source, $Out, $Size, $CenterX, $CenterY, $Threshold)
Write-Output ("crop: {0}x{0} at ({1},{2})  ->  {3}x{3}" -f $result[0], $result[1], $result[2], $Size)
Write-Output ("output: {0} ({1:N0} bytes)" -f $Out, (Get-Item $Out).Length)
