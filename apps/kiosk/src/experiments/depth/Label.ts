// @ts-nocheck — vendored port of Codrops depth-gallery (houmahani/codrops-depth-gallery, MIT)
// Adapted: left color word/chip + CMYK/RGB/HEX/PMS card removed. Now shows the open-topic
// title + kind (e.g. "3D Reconstruction" / "Master Thesis") on the right, plus an "Open Topic"
// intro heading that greets on entry and fades out as the first plane leaves.
class Label {
  constructor(gallery) {
    this.gallery = gallery

    this.overlayElement = null
    this.titleElement = null
    this.kindElement = null
    this.introElement = null
    this.activePlaneIndex = -1
    this.isVisible = true // host may flip this before init() builds the elements
  }

  createElement() {
    const element = document.createElement('section')
    element.className = 'plane-label-overlay'
    element.innerHTML = `
      <article class="plane-label-card plane-label-overlay__right">
        <h2 class="plane-label-card__title"></h2>
        <p class="plane-label-card__kind"></p>
      </article>
    `

    return {
      element,
      titleElement: element.querySelector('.plane-label-card__title'),
      kindElement: element.querySelector('.plane-label-card__kind'),
    }
  }

  createIntroElement() {
    const element = document.createElement('div')
    element.className = 'plane-intro-overlay'
    element.innerHTML = `
      <h1 class="plane-intro__title">Open Topics</h1>
    `
    return element
  }

  init(root = null) {
    if (this.overlayElement) return

    const host = root || document.body
    const { element, titleElement, kindElement } = this.createElement()

    this.overlayElement = element
    this.titleElement = titleElement
    this.kindElement = kindElement
    this.overlayElement.style.opacity = '0'

    this.introElement = this.createIntroElement()
    this.introElement.style.opacity = '0'

    host.append(this.overlayElement)
    host.append(this.introElement)

    this.applyVisibility() // honor a visibility set before the elements existed
  }

  getTargetPlaneIndex(cameraZ) {
    const blendData = this.gallery.getPlaneBlendData(cameraZ)
    if (!blendData) return -1
    return blendData.blend >= 0.5 ? blendData.nextPlaneIndex : blendData.currentPlaneIndex
  }

  applyPlaneContent(planeIndex) {
    const plane = this.gallery.planes[planeIndex]
    if (!plane || this.activePlaneIndex === planeIndex) return

    const labelData = plane.userData.label || {}

    this.titleElement.textContent = labelData.title || 'Open Topic'
    this.kindElement.textContent = labelData.kind || ''
    this.overlayElement.style.color = labelData.color || ''

    // First plane reads as a normal editorial section: caption sits beside the poster
    // (--cover). Every later plane keeps the original far-right depth-gallery label.
    this.overlayElement.classList.toggle('plane-label-overlay--cover', planeIndex === 0)

    this.activePlaneIndex = planeIndex
  }

  // The intro heading lives on the first plane: full opacity at entry, fading to 0 as the
  // camera crosses from plane 0 toward plane 1, then gone for every plane after.
  updateIntro(cameraZ) {
    if (!this.introElement) return

    const blendData = this.gallery.getPlaneBlendData(cameraZ)
    let introOpacity = 0
    if (blendData && blendData.currentPlaneIndex === 0) {
      introOpacity = 1 - blendData.blend
    }
    this.introElement.style.opacity = String(introOpacity)
  }

  resize() {}

  // Toggle both DOM overlays as a unit (home integration hides them when the section is idle).
  // The flag is remembered so a call before init() still takes effect once elements exist.
  setVisible(visible) {
    this.isVisible = visible
    this.applyVisibility()
  }

  applyVisibility() {
    const display = this.isVisible ? '' : 'none'
    if (this.overlayElement) this.overlayElement.style.display = display
    if (this.introElement) this.introElement.style.display = display
  }

  update(camera = null) {
    if (!camera || !this.overlayElement) return

    this.updateIntro(camera.position.z)

    const targetPlaneIndex = this.getTargetPlaneIndex(camera.position.z)
    if (targetPlaneIndex < 0) {
      this.overlayElement.style.opacity = '0'
      return
    }

    this.applyPlaneContent(targetPlaneIndex)
    this.overlayElement.style.opacity = '1'
  }

  render() {}

  dispose() {
    this.overlayElement?.remove()
    this.introElement?.remove()
    this.overlayElement = null
    this.titleElement = null
    this.kindElement = null
    this.introElement = null
    this.activePlaneIndex = -1
  }
}

export { Label }
