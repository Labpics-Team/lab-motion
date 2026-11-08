#define PREFERENCE_DIAGNOSTICS_TEST
#include "../../examples/windows/native/PreferenceDiagnostics.cpp"
#include <iostream>
#include <thread>
#include <vector>

using namespace PreferenceDiagnostics;
using MessageDelegate = ABI::Windows::Foundation::ITypedEventHandler<View::UISettings*, View::UISettingsMessageDurationChangedEventArgs*>;

// Настоящие SDK ABI и WRL QI/refcount; все неиспользуемые getters отвергаются.
class Settings final : public Microsoft::WRL::RuntimeClass<
    Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::WinRt>, View::IUISettings, View::IUISettings6>
{
    InspectableClass(L"DiagnosticFixture.Settings", BaseTrust);
public:
    ComPtr<Delegate> event;
    HRESULT addResult = S_OK, removeResult = S_OK;
    int adds = 0, removes = 0;
    bool synchronous = false;
    HRESULT STDMETHODCALLTYPE add_AnimationsEnabledChanged(Delegate* receiver, EventRegistrationToken* token) override
    {
        ++adds;
        if (FAILED(addResult)) return addResult;
        event = receiver;
        token->value = 0; // Ноль допустим: attached определяется HRESULT, не token.
        if (synchronous) return Fire();
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE remove_AnimationsEnabledChanged(EventRegistrationToken token) override
    {
        ++removes;
        if (token.value != 0) return E_INVALIDARG;
        if (SUCCEEDED(removeResult)) event.Reset();
        return removeResult;
    }
    HRESULT Fire() { return event->Invoke(static_cast<View::IUISettings*>(this), nullptr); }
    HRESULT STDMETHODCALLTYPE add_MessageDurationChanged(MessageDelegate*, EventRegistrationToken*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE remove_MessageDurationChanged(EventRegistrationToken) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_HandPreference(View::HandPreference*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_CursorSize(ABI::Windows::Foundation::Size*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_ScrollBarSize(ABI::Windows::Foundation::Size*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_ScrollBarArrowSize(ABI::Windows::Foundation::Size*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_ScrollBarThumbBoxSize(ABI::Windows::Foundation::Size*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_MessageDuration(UINT32*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_AnimationsEnabled(boolean*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_CaretBrowsingEnabled(boolean*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_CaretBlinkRate(UINT32*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_CaretWidth(UINT32*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_DoubleClickTime(UINT32*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE get_MouseHoverTime(UINT32*) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE UIElementColor(View::UIElementType, ABI::Windows::UI::Color*) override { return E_NOTIMPL; }
};

static void Require(bool accepted, const char* name)
{
    if (!accepted) throw name;
}

static Handle* Open(Settings* source, Snapshot& snapshot)
{
    Handle* handle = nullptr;
    const HRESULT hr = PreferenceDiagnosticsCreate(static_cast<View::IUISettings*>(source), &handle, &snapshot);
    Require(SUCCEEDED(hr) && handle, "native-create");
    return handle;
}

int main()
{
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    struct Apartment
    {
        bool initialized;
        ~Apartment() { if (initialized) CoUninitialize(); }
    } apartment{ SUCCEEDED(initialized) };
    try
    {
        Require(SUCCEEDED(initialized), "fixture-mta-initialization");
        Snapshot captured;
        Handle* missing = nullptr;
        Require(FAILED(PreferenceDiagnosticsCreate(nullptr, &missing, &captured)) && !missing &&
            (captured.flags & Faulted) && !(captured.flags & Attached), "missing-source-not-zero-success");
        {
            auto source = Microsoft::WRL::Make<Settings>();
            auto* handle = Open(source.Get(), captured);
            Require((captured.flags & (SameSource | ControlPassed | Attached | Active)) == (SameSource | ControlPassed | Attached | Active)
                && captured.delegateResult == S_OK && captured.marshalResult == S_OK && captured.controlResult == S_OK
                && captured.controlCount == 1 && captured.controlQpc > 0 && captured.count == 0 && captured.lastQpc == 0
                && captured.frequency > 0 && source->adds == 1, "control-separate-reset-before-add-zero-token");
            Require(SUCCEEDED(source->Fire()), "actual-fixture-invoke");
            Require(SUCCEEDED(PreferenceDiagnosticsRead(handle, &captured)) && captured.count == 1 && captured.lastQpc > 0,
                "same-recorder-actual-positive");
            ComPtr<Delegate> inFlight = source->event;
            auto* record = handle->record;
            Require(SUCCEEDED(PreferenceDiagnosticsClose(handle, &captured)) && !(captured.flags & (Attached | Active)), "successful-remove");
            PreferenceDiagnosticsClose(handle, &captured);
            Require(source->removes == 1, "one-only-remove");
            PreferenceDiagnosticsRelease(handle);
            Require(recordsAlive == 1 && SUCCEEDED(inFlight->Invoke(static_cast<View::IUISettings*>(source.Get()), nullptr)), "inflight-record-survives-owner");
            captured = Read(record);
            Require(captured.count == 2 && !(captured.flags & Active), "late-raw-not-active");
            inFlight.Reset();
            Require(recordsAlive == 0, "record-reclaimed-after-last-callback");
        }
        {
            auto source = Microsoft::WRL::Make<Settings>();
            source->removeResult = E_FAIL;
            auto* handle = Open(source.Get(), captured);
            auto* record = handle->record;
            Require(FAILED(PreferenceDiagnosticsClose(handle, &captured)) && (captured.flags & Attached) &&
                (captured.flags & Faulted) && !(captured.flags & Active) && captured.removeResult == E_FAIL, "failed-remove-attached-faulted");
            PreferenceDiagnosticsClose(handle, &captured);
            Require(source->removes == 1, "failed-remove-not-retried");
            PreferenceDiagnosticsRelease(handle);
            Require(recordsAlive == 1 && SUCCEEDED(source->Fire()), "failed-remove-retained-callback-record");
            captured = Read(record);
            Require(captured.count == 1 && !(captured.flags & Active) && (captured.flags & Attached), "failed-remove-late-state");
            source->event.Reset();
            Require(recordsAlive == 0, "failed-remove-no-source-cycle");
        }
        {
            auto source = Microsoft::WRL::Make<Settings>();
            source->addResult = E_ACCESSDENIED;
            Handle* handle = nullptr;
            Require(PreferenceDiagnosticsCreate(static_cast<View::IUISettings*>(source.Get()), &handle, &captured) == E_ACCESSDENIED
                && !handle && (captured.flags & ControlPassed) && (captured.flags & Faulted) && !(captured.flags & (Attached | Active))
                && captured.addResult == E_ACCESSDENIED && recordsAlive == 0, "add-failure-not-source-zero");
        }
        {
            auto source = Microsoft::WRL::Make<Settings>();
            source->synchronous = true;
            auto* handle = Open(source.Get(), captured);
            Require(captured.count == 1 && captured.controlCount == 1, "synchronous-add-entry-after-reset");
            std::vector<std::thread> workers;
            for (int worker = 0; worker < 4; ++worker) workers.emplace_back([source]() {
                for (int index = 0; index < 500; ++index) source->Fire();
            });
            for (auto& worker : workers) worker.join();
            Require(SUCCEEDED(PreferenceDiagnosticsRead(handle, &captured)) && captured.count == 2001 && captured.lastQpc > 0
                && !(captured.flags & Faulted), "concurrent-counter-qpc-coherent");
            AcquireSRWLockExclusive(&handle->record->lock);
            handle->record->snapshot.count = MaximumSafeInteger;
            ReleaseSRWLockExclusive(&handle->record->lock);
            source->Fire();
            PreferenceDiagnosticsRead(handle, &captured);
            Require(captured.count == MaximumSafeInteger && (captured.flags & Faulted), "overflow-explicit-fault");
            PreferenceDiagnosticsClose(handle, &captured);
            PreferenceDiagnosticsRelease(handle);
        }
        Require(recordsAlive == 0, "all-records-reclaimed");
        std::cout << "native preference controls: typed ABI/FTM/control-reset/lifetime/faults/concurrency PASS\n";
        return 0;
    }
    catch (const char* failure) { std::cerr << failure << '\n'; return 1; }
    catch (...) { std::cerr << "native-control-unexpected-failure\n"; return 1; }
}
