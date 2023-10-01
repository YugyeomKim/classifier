figma.skipInvisibleInstanceChildren = true

/**
 * Returns the label for the given index
 * @param index
 * @returns
 */
const indexToLabel = (index: number) => {
  switch (index) {
    case 0:
      return 'other'
    case 1:
      return 'button'
    default:
      return 'other'
  }
}

/**
 * Get the Z index of the node in its parent
 * @param node
 * @returns
 */
const getZIndex = (node: SceneNode) => {
  return node.parent?.children.indexOf(node) || 0
}

/**
 * Returns the class of the given node
 *
 * It uses the model running on Server
 * @param node
 * @returns
 */
const getClass = async (node: SceneNode) => {
  const bytes = await node
    .exportAsync({ format: 'JPG', contentsOnly: false })
    .catch((e) => {
      console.error(`${node.name}: ${e}`)
    })

  if (!bytes) {
    return 'error'
  }

  /**
   * Fetch result from the model to predict the class
   */
  const modelResult = await fetch('http://localhost:3000/predict', {
    method: 'POST',
    body: bytes,
  })

  if (modelResult.ok) {
    const result = await modelResult.text()
    const label = indexToLabel(parseInt(result))

    console.log(`${node.name}: ${label}`)

    return label
  } else {
    const errorMessage = await modelResult.text()
    console.error(`${node.name}: ${errorMessage}`)

    return 'error'
  }
}

async function main() {
  const frames = figma.currentPage.selection

  /**
   * Results from the model
   */
  const allResults = await Promise.allSettled(
    frames.map(async (frame) => {
      if (frame.type !== 'FRAME') {
        throw new Error('Not a frame')
      } else {
        const nodes = frame.findAll((node) => node.type !== 'TEXT')
        const classes = await Promise.all(nodes.map(getClass))

        return nodes.filter((_v, i) => classes[i] === 'button')
      }
    })
  )

  /**
   * All the errors from the model
   */
  const rejectReasons = []
  /**
   * All the buttons from the selected frames
   */
  const allElements = allResults.reduce<SceneNode[]>((acc, cur) => {
    if (cur.status === 'fulfilled') {
      return [...acc, ...cur.value]
    } else {
      rejectReasons.push(cur)
      return acc
    }
  }, [])

  // Sort the buttons by width
  allElements.sort((a, b) => a.width - b.width)

  /**
   * Create a new page for the component library
   */
  let componentLibraryPage = figma.root.findChild(
    (node) => node.name === '🧊Components Library'
  )

  if (!componentLibraryPage) {
    componentLibraryPage = figma.createPage()
    componentLibraryPage.name = '🧊Components Library'
  }

  let x = 20
  let y = 20
  let maxX = 20
  /** list of the elements that should be replaced (removed) */
  const tobeRemoved = []

  /** Section to put in all the components */
  let section = componentLibraryPage.findChild(
    (node) => node.name === 'Buttons' && node.type === 'SECTION'
  ) as SectionNode | null

  if (!section) {
    section = figma.createSection()
    section.name = 'Buttons'
    componentLibraryPage.appendChild(section)
  } else {
    maxX = section.width - 20
    y = section.height
  }

  // Put all elements vertically on the section
  for (const element of allElements) {
    const zIndexOfElement = getZIndex(element)
    const parts =
      element.parent?.findAll((node) => {
        const zIndexOfOther = getZIndex(node)
        return (
          zIndexOfElement < zIndexOfOther &&
          node.x > element.x &&
          node.x + node.width < element.x + element.width &&
          node.y > element.y &&
          node.y + node.height < element.y + element.height
        )
      }) || []

    const newElement = element.clone()

    const newParts = parts.map((part) => part.clone())

    const component = figma.createComponent()
    const newGroup = figma.group([newElement, ...newParts], component)

    component.name = element.name
    component.resizeWithoutConstraints(newGroup.width, newGroup.height)
    component.x = x
    component.y = y

    newGroup.x = 0
    newGroup.y = 0

    if (newElement.type === 'INSTANCE') {
      newElement.detachInstance()
    }

    section.appendChild(component)

    // Replace the original element with the new component if the original element is not an instance nor a component
    if (element.type !== 'INSTANCE' && element.type !== 'COMPONENT') {
      /** New instance to replace the original element */
      const newInstance = component.createInstance()
      newInstance.x = element.x
      newInstance.y = element.y
      element.parent?.appendChild(newInstance)
      tobeRemoved.push(element)
      parts.forEach((part) => tobeRemoved.push(part))
    }

    y += element.height + 20
    if (x + element.width > maxX) {
      maxX = x + element.width
    }
  }

  // Resize section to fit all the components
  section.resizeWithoutConstraints(maxX + 20, y)
  tobeRemoved.forEach((element) => element.remove())

  figma.currentPage = componentLibraryPage
  figma.closePlugin('Done😊')
}

main()
