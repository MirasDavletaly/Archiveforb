// Package icon draws the app icon (a manila folder with a download arrow) so no image files need to ship.
package icon

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"math"
)

var (
	manila = [3]float64{0xD9, 0xAE, 0x52}
	tab    = [3]float64{0xB0, 0x82, 0x28}
	ink    = [3]float64{0x1F, 0x26, 0x24}
)

// rounded rectangle in a 64x64 design grid
func inBox(x, y, x0, y0, x1, y1, r float64) bool {
	if x < x0 || x > x1 || y < y0 || y > y1 {
		return false
	}
	cx := math.Max(x0+r, math.Min(x, x1-r))
	cy := math.Max(y0+r, math.Min(y, y1-r))
	return (x-cx)*(x-cx)+(y-cy)*(y-cy) <= r*r
}

func inArrow(x, y float64) bool {
	if x >= 28.5 && x <= 35.5 && y >= 24 && y <= 39 {
		return true
	}
	if y >= 36 && y <= 49 {
		return math.Abs(x-32) <= (49-y)*12/13
	}
	return false
}

// layer at a point in the design grid: top-most paint, or nil
func paint(x, y float64) *[3]float64 {
	switch {
	case inArrow(x, y):
		return &ink
	case inBox(x, y, 4, 17, 60, 56, 5):
		return &manila
	case inBox(x, y, 4, 10, 29, 24, 4):
		return &tab
	}
	return nil
}

// PNG returns the icon as a size×size PNG, antialiased by 4×4 supersampling.
func PNG(size int) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	scale := 64 / float64(size)
	for py := 0; py < size; py++ {
		for px := 0; px < size; px++ {
			var r, g, b, n float64
			for sy := 0; sy < 4; sy++ {
				for sx := 0; sx < 4; sx++ {
					c := paint((float64(px)+(float64(sx)+0.5)/4)*scale, (float64(py)+(float64(sy)+0.5)/4)*scale)
					if c != nil {
						r, g, b, n = r+c[0], g+c[1], b+c[2], n+1
					}
				}
			}
			if n > 0 {
				img.SetNRGBA(px, py, color.NRGBA{uint8(r / n), uint8(g / n), uint8(b / n), uint8(255 * n / 16)})
			}
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

// ICO returns a Windows .ico holding PNG images of the given sizes (supported since Windows Vista).
func ICO(sizes ...int) []byte {
	var head, data bytes.Buffer
	binary.Write(&head, binary.LittleEndian, [3]uint16{0, 1, uint16(len(sizes))})
	offset := 6 + 16*len(sizes)
	for _, s := range sizes {
		p := PNG(s)
		dim := uint8(s)
		if s >= 256 {
			dim = 0
		}
		head.Write([]byte{dim, dim, 0, 0})
		binary.Write(&head, binary.LittleEndian, [2]uint16{1, 32})
		binary.Write(&head, binary.LittleEndian, [2]uint32{uint32(len(p)), uint32(offset)})
		offset += len(p)
		data.Write(p)
	}
	return append(head.Bytes(), data.Bytes()...)
}
