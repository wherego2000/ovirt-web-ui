import { takeEvery, put } from 'redux-saga/effects'

import { CREATE_DISK_FOR_VM, REMOVE_DISK, EDIT_VM_DISK } from '../constants'
import Api from '../ovirtapi'
import { callExternalAction, delay, delayInMsSteps } from './utils'
import { fetchDisks } from '../sagas'

import {
  addDiskRemovalPendingTask,
  removeDiskRemovalPendingTask,
  extractErrorText,
  updateVmDisk,
} from '../actions'
import {
  setNewDiskDialogProgressIndicator,
  setNewDiskDialogErrorText,
  setNewDiskDialogDone,
} from '../components/NewDiskDialog/actions'

function* createDiskForVm (action) {
  yield put(setNewDiskDialogProgressIndicator(true))
  const vmId = action.payload.vmId

  const result = yield callExternalAction('addDiskAttachment', Api.addDiskAttachment, action)
  if (result.error) {
    const errorText = extractErrorText(result.error)
    yield put(setNewDiskDialogErrorText(errorText))
  } else {
    yield fetchDisks({ vms: [ { id: vmId } ] })
    yield waitForDiskToBeUnlocked(vmId, result.id)
    yield put(setNewDiskDialogDone())
  }
  yield put(setNewDiskDialogProgressIndicator(false))
}

function* removeDisk (action) {
  const diskId = action.payload.diskId
  const vmToRefreshId = action.payload.vmToRefreshId

  const result = yield callExternalAction('removeDisk', Api.removeDisk, { payload: diskId })
  if (result.error) {
    return
  }

  yield put(addDiskRemovalPendingTask(diskId))
  const diskRemoved = yield waitForDiskAttachment(
    vmToRefreshId,
    diskId,
    attachment => attachment.error && attachment.error.status === 404,
    true
  )
  yield put(removeDiskRemovalPendingTask(diskId))

  if (diskRemoved && vmToRefreshId) {
    yield fetchDisks({ vms: [ { id: vmToRefreshId } ] })
  }
}

function* editDiskOnVm (action) {
  const { disk, vmId } = action.payload

  // only allow editing name and provisionedSize
  const editableFieldsDisk = {
    attachmentId: disk.attachmentId,
    id: disk.id,
    name: disk.name,
    provisionedSize: disk.provisionedSize, // only for type === 'image'
  }

  action.payload.disk = editableFieldsDisk
  const result = yield callExternalAction('updateDiskAttachment', Api.updateDiskAttachment, action)
  if (result.error) {
    return
  }

  yield waitForDiskToBeUnlocked(vmId, disk.id)
  yield fetchDisks({ vms: [ { id: vmId } ] })
}

function* waitForDiskToBeUnlocked (vmId, attachmentId) {
  return yield waitForDiskAttachment(
    vmId,
    attachmentId,
    attachment => attachment.disk && attachment.disk.status && attachment.disk.status !== 'locked',
  )
}

// TODO: drop polling in favor of events (see https://github.com/oVirt/ovirt-web-ui/pull/390)
function* waitForDiskAttachment (vmId, attachmentId, test, canBeMissing = false) {
  let metTest = false

  for (let delayMs of delayInMsSteps()) {
    const apiDiskAttachment = yield callExternalAction(
      'diskattachment',
      Api.diskattachment,
      { payload: { vmId, attachmentId } },
      canBeMissing
    )

    if (!apiDiskAttachment.error) {
      const apiDisk = apiDiskAttachment.disk
      const edited = Api.diskToInternal({ attachment: apiDiskAttachment, disk: apiDisk })
      if (vmId) {
        yield put(updateVmDisk({ vmId, disk: edited }))
      }
    }

    if (test(apiDiskAttachment)) {
      metTest = true
      break
    } else {
      yield delay(delayMs)
    }
  }

  return metTest
}

export default [
  takeEvery(CREATE_DISK_FOR_VM, createDiskForVm),
  takeEvery(REMOVE_DISK, removeDisk),
  takeEvery(EDIT_VM_DISK, editDiskOnVm),
]
