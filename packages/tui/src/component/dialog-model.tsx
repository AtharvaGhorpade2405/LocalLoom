import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { DIALOG_LIST_INSET, useDialog } from "../ui/dialog"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useData } from "../context/data"
import { useTheme } from "../context/theme"
import { useRoute } from "../context/route"
import { useClient } from "../context/client"
import { modelPreferenceKey } from "../model-preference"
import { useLocation } from "../context/location"
import { useNewDesigns } from "../config"
import { FavoriteMarker, ModelDetail, prioritizeFavorites, sortModelOptions } from "./model-options"

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const dialog = useDialog()
  const route = useRoute()
  const client = useClient()

  function select(providerID: string, modelID: string) {
    local.model.set({ providerID, modelID }, { recent: true })
    if (route.data.type === "session") {
      void client.api.session
        .switchModel({
          sessionID: route.data.sessionID,
          model: { providerID, id: modelID },
        })
        .catch(() => undefined)
    }
    const list = local.model.variant.list()
    const cur = local.model.variant.current()
    if (cur && list.includes(cur)) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  return <DialogConnectedModels providerID={props.providerID} onSelect={select} />
}

function DialogConnectedModels(props: {
  providerID?: string
  onSelect: (providerID: string, modelID: string) => void
}) {
  const local = useLocal()
  const newDesigns = useNewDesigns()
  const data = useData()
  const theme = useTheme()
  const dialog = useDialog()
  const location = useLocation()
  const [query, setQuery] = createSignal("")
  // Under new designs, favoriting does not reorder the list until the dialog is reopened.
  const favoritesAtOpen = [...local.model.favorite()]
  const favoritePriority = new Set(favoritesAtOpen.map(modelPreferenceKey))
  const isFavorite = (value: { providerID: string; modelID: string } | undefined) =>
    value !== undefined &&
    local.model.favorite().some((item) => item.providerID === value.providerID && item.modelID === value.modelID)

  const isActive = (value: { providerID: string; modelID: string } | undefined) => {
    const cur = local.model.current()
    return cur !== undefined && value !== undefined && cur.providerID === value.providerID && cur.modelID === value.modelID
  }

  // Trailing indicator: marks active status and favorites.
  const trailing = (favorite: boolean, active: boolean) => {
    if (active && favorite) {
      return (
        <>
          <span style={{ fg: theme.text.formfield.selected, attributes: TextAttributes.BOLD }}>Active </span>
          <FavoriteMarker />
        </>
      )
    }
    if (active) {
      return (
        <span style={{ fg: theme.text.formfield.selected, attributes: TextAttributes.BOLD }}>
          Active
        </span>
      )
    }
    if (favorite) {
      return <FavoriteMarker />
    }
    return undefined
  }

  const providers = createMemo(
    () => new Map((data.location.provider.list(location.ref) ?? []).map((item) => [item.id, item])),
  )
  const models = createMemo(() => data.location.model.list(location.ref) ?? [])

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = !props.providerID && needle.length === 0
    const favorites = newDesigns() ? favoritesAtOpen : local.model.favorite()
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const model = models().find((m) => m.providerID === item.providerID && m.id === item.modelID)
        if (!model) return []
        const active = isActive(item)
        return [
          {
            key: item,
            value: { providerID: model.providerID, modelID: model.id },
            title: model.name,
            releaseDate: model.time.released,
            description: `${model.providerID}/${model.id}`,
            category,
            footer: trailing(isFavorite(item), active),
            detail: newDesigns() ? () => <ModelDetail model={model} /> : undefined,
            onSelect: () => {
              props.onSelect(model.providerID, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, "Favorites")
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

    const modelOptions = sortModelOptions(
      models()
        .filter((model) => model.status !== "deprecated")
        .filter((model) => (props.providerID ? model.providerID === props.providerID : true))
        .map((model) => {
          const provider = providers().get(model.providerID)
          const value = { providerID: model.providerID, modelID: model.id }
          const favorite = isFavorite(value)
          const active = isActive(value)
          return {
            value,
            providerID: model.providerID,
            providerName: provider?.name ?? model.providerID,
            title: model.name,
            releaseDate: model.time.released,
            description: `${model.providerID}/${model.id}`,
            category: provider?.name ?? model.providerID,
            footer: trailing(favorite, active),
            free: true,
            detail: newDesigns() ? () => <ModelDetail model={model} /> : undefined,
            onSelect() {
              props.onSelect(model.providerID, model.id)
            },
          }
        })
        .filter((option) => {
          if (!showSections) return true
          if (
            favorites.some(
              (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
            )
          )
            return false
          if (
            recents.some((item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID)
          )
            return false
          return true
        }),
      true,
    )

    if (needle) {
      const results = prioritizeFavorites(
        sortModelOptions(
          fuzzysort.go(needle, modelOptions, { keys: ["title", "description", "category"] }).map((item) => item.obj),
          false,
        ),
        favoritePriority,
      )
      if (!newDesigns()) return results
      return results.map((option) => ({ ...option, description: option.providerName, category: undefined }))
    }

    return [
      ...favoriteOptions,
      ...recentOptions,
      ...modelOptions,
    ]
  })

  const provider = createMemo(() => (props.providerID ? providers().get(props.providerID) : undefined))

  const title = createMemo(() => {
    const value = provider()
    if (!value) return "Select model"
    return value.name
  })

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      searchInTitle
      titlePlaceholder="Search models"
      options={options()}
      onCancel={() => dialog.clear()}
      emptyView={
        <box paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET}>
          <text fg={theme.text.feedback.error.base} attributes={TextAttributes.BOLD}>
            No local models found
          </text>
          <text fg={theme.text.muted}>Please ensure Ollama is running at http://127.0.0.1:11434</text>
          <text fg={theme.text.muted}>Install models with: ollama pull qwen2.5-coder:7b</text>
          <text fg={theme.text.muted}>After starting Ollama or pulling models, press 'refresh models'.</text>
        </box>
      }
      actions={[
        {
          command: "model.dialog.refresh",
          title: "refresh models",
          selection: "none",
          onTrigger: async () => {
            data.location.model.invalidate(location.ref)
            await data.location.model.sync(location.ref)
          },
        },
        {
          command: "model.dialog.favorite",
          title: newDesigns() ? (option) => (isFavorite(option?.value) ? "unfavorite" : "favorite") : "Favorite",
          onTrigger: (option) => {
            local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={local.model.current()}
    />
  )
}
