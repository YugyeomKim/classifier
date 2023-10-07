figma.skipInvisibleInstanceChildren = true

/**
 * Returns the label for the given index
 * @param index
 * @returns
 */
const indexToLabel = (index: number) => {
  switch (index) {
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

/**
 * Get class of children of the given node using getClass function recursively.
 *
 * if a child is 'button', it will return the node without checking the children of the child.
 *
 * Consequently, it return the list of nodes that are 'button'.
 *
 * @param node
 * @returns {Promise<SceneNode[]>}
 */
const getElementsFromChildren = async (
  node: SceneNode
): Promise<SceneNode[]> => {
  if (!('children' in node)) return []

  const children = node.children
  const classes = await Promise.all(children.map(getClass))

  const buttonFromChildren = await Promise.all(
    children
      .filter((_v, i) => classes[i] !== 'button')
      .map(getElementsFromChildren)
  )
  const buttonFromChildrenFlatten = ([] as SceneNode[]).concat(
    ...buttonFromChildren
  )

  const buttons = children.filter((_v, i) => classes[i] === 'button')
  return [...buttons, ...buttonFromChildrenFlatten]
}

/**
 * Remove all nodes that overlap each other except the one with the largest area.
 * @param nodes
 * @returns {SceneNode[]} nodes that are not overlapped
 */
const removeOverlap = (nodes: SceneNode[]): SceneNode[] => {
  const result = nodes.reduce<SceneNode[]>((acc, cur) => {
    const curX = cur.absoluteBoundingBox?.x
    const curY = cur.absoluteBoundingBox?.y
    if (!curX || !curY) return acc

    const padding = 10

    const overlap = acc.filter((other) => {
      const otherX = other.absoluteBoundingBox?.x
      const otherY = other.absoluteBoundingBox?.y
      if (!otherX || !otherY) return false

      return (
        curX + padding < otherX + other.width &&
        curX + cur.width > otherX + padding &&
        curY + padding < otherY + other.height &&
        curY + cur.height > otherY + padding
      )
    })

    if (overlap.length === 0) {
      return [...acc, cur]
    } else {
      return acc
    }
  }, [])

  return result
}

/**
 * Find all the nodes that match the given condition.
 *
 * But don't look inside the nodes that match the condition
 * @param node
 * @param cb
 */
const findAll = (
  node: SceneNode,
  cb: (node: SceneNode) => boolean
): SceneNode[] => {
  if (!('children' in node)) return [] as SceneNode[]

  const children = node.children
  const result = children.reduce((acc, cur) => {
    if (cb(cur)) {
      return [...acc, cur]
    } else {
      return [...acc, ...findAll(cur, cb)]
    }
  }, [] as SceneNode[])

  return result
}

/**
 * Check if the given node is inside of a component or instance.
 * @param node
 * @returns {boolean}
 */
const isInsideComponentOrInstance = (node: SceneNode): boolean => {
  if (!node.parent) return false

  if (node.parent.type === 'COMPONENT' || node.parent.type === 'INSTANCE') {
    return true
  } else {
    if (node.parent.type === 'DOCUMENT' || node.parent.type === 'PAGE')
      return false
    return isInsideComponentOrInstance(node.parent)
  }
}

async function main() {
  const frames = figma.currentPage.selection

  /**
   * Results from the model if each parts is a button or not
   */
  const allResults = await Promise.allSettled(
    frames.map(async (frame) => {
      if (frame.type !== 'FRAME') {
        throw new Error('Not a frame')
      } else {
        const elementsWithOverlap = await getElementsFromChildren(frame)

        const elements = removeOverlap(elementsWithOverlap)

        return {
          frame,
          elements,
        }
      }
    })
  )

  /**
   * All the errors from the model
   */
  const rejectReasons: any = {}

  // Get all fulfilled elements (results) out of the allResults from the model
  const {
    frameArray: frameArrayByModel,
    originalElementArray: originalElementArrayByModel,
  } = allResults.reduce<{
    frameArray: FrameNode[]
    originalElementArray: SceneNode[]
  }>(
    (acc, cur) => {
      if (cur.status === 'fulfilled') {
        const newFrameArray: FrameNode[] = new Array(
          cur.value.elements.length
        ).fill(cur.value.frame)

        return {
          frameArray: [...acc.frameArray, ...newFrameArray],
          originalElementArray: [
            ...acc.originalElementArray,
            ...cur.value.elements,
          ],
        }
      } else {
        rejectReasons[cur.reason] = (rejectReasons[cur.reason] || 0) + 1

        return acc
      }
    },
    { frameArray: [], originalElementArray: [] }
  )

  // Get all the elements that have the name 'button'
  const allResultsByName = frames.map((frame) => {
    if (frame.type !== 'FRAME') {
      /** @todo error handling */
      figma.notify('Not a frame', { error: true })
      return {} as { frame: FrameNode; elements: SceneNode[] }
    }

    const elements = findAll(
      frame,
      (node) => node.type !== 'TEXT' && node.name === 'button'
    )
    return {
      frame,
      elements,
    }
  })

  // Get all frames matches to the elements
  const {
    frameArray: frameArrayByName,
    originalElementArray: originalElementArrayByName,
  } = allResultsByName.reduce<{
    frameArray: FrameNode[]
    originalElementArray: SceneNode[]
  }>(
    (acc, cur) => {
      const newFrameArray: FrameNode[] = new Array(cur.elements.length).fill(
        cur.frame
      )

      return {
        frameArray: [...acc.frameArray, ...newFrameArray],
        originalElementArray: [...acc.originalElementArray, ...cur.elements],
      }
    },
    {
      frameArray: [],
      originalElementArray: [],
    }
  )

  // Concat the results from the model and the results from the name
  const frameArrayConcat = frameArrayByModel.concat(frameArrayByName)
  const originalElementArrayConcat = originalElementArrayByModel.concat(
    originalElementArrayByName
  )

  // Sort the buttons by width
  const indices = Array.from(originalElementArrayConcat.keys())
  indices.sort(
    (a, b) =>
      originalElementArrayConcat[a].width - originalElementArrayConcat[b].width
  )

  const frameArray = indices.map((i) => frameArrayConcat[i])
  const originalElementArray = indices.map((i) => originalElementArrayConcat[i])

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

  /** Section to put in all the components */
  let section = componentLibraryPage.findChild(
    (node) => node.name === 'BUTTONS' && node.type === 'SECTION'
  ) as SectionNode | null

  if (!section) {
    section = figma.createSection()
    section.name = 'BUTTONS'
    componentLibraryPage.appendChild(section)
  } else {
    maxX = section.width - 20
    y = section.height
  }

  // Put all elements vertically on the section
  for (const element of originalElementArray) {
    /** Absolute position x of the element */
    const elementX = element.absoluteBoundingBox?.x
    /** Absolute position y of the element */
    const elementY = element.absoluteBoundingBox?.y
    if (!elementX || !elementY) continue

    const zIndexOfElement = getZIndex(element)
    /** All parts that is on the element. If the element is by name, it is empty array */
    const parts =
      element.name === 'button'
        ? []
        : element.parent?.findChildren((node) => {
            const nodeX = node.absoluteBoundingBox?.x
            const nodeY = node.absoluteBoundingBox?.y
            if (!nodeX || !nodeY) return false

            const zIndexOfOther = getZIndex(node)
            const padding = 10
            return (
              zIndexOfElement < zIndexOfOther &&
              nodeX + padding > elementX &&
              nodeX + node.width < elementX + element.width + padding &&
              nodeY + padding > elementY &&
              nodeY + node.height < elementY + element.height + padding
            )
          }) || []
    
    // Clone the element and parts to put it in the component
    const newElement = element.clone()
    const newParts = parts.map((part) => part.clone())

    // Create a component and put the element and parts in it
    const newGroup = figma.group([newElement, ...newParts], figma.currentPage)
    section.appendChild(newGroup)

    newGroup.name = element.name
    newGroup.x = x
    newGroup.y = y

    if (newElement.type === 'INSTANCE') {
      newElement.detachInstance()
    }

    if (newGroup.children.length < 2){
      figma.ungroup(newGroup)
    }

    // Update the position for the next element
    y += element.height + 20
    if (x + element.width > maxX) {
      maxX = x + element.width
    }
  }

  // Resize section to fit all the components
  section.resizeWithoutConstraints(maxX + 20, y)

  figma.currentPage = componentLibraryPage

  // Show the ending page
  figma.showUI(__html__, { width: 400, height: 300 })
  figma.ui.postMessage({ type: 'rejectReasons', rejectReasons })
}

figma.ui.onmessage = (msg) => {
  switch (msg.type) {
    case 'submit':
      figma.closePlugin('Done😊')
      break

    default:
      figma.closePlugin('Done😊')
      break
  }
}

main()
