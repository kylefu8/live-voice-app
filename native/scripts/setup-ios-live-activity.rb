#!/usr/bin/env ruby
# Run on macOS after syncing sources. Optional project path supports preparing
# the unsigned repository project separately from a user's local signing setup.
require 'pathname'
require 'xcodeproj'

path = ARGV[0] || Pathname(__dir__).parent.join('ios/LiveVoiceApp.xcodeproj').to_s
project = Xcodeproj::Project.open(path)
app = project.targets.find { |target| target.name == 'LiveVoiceApp' }
abort 'Missing LiveVoiceApp target' unless app
widget = project.targets.find { |target| target.name == 'LiveVoiceActivity' }
widget ||= project.new_target(:app_extension, 'LiveVoiceActivity', :ios, '16.2', nil, :swift)

def add_source(project, group, file_path, targets)
  file = project.files.find { |item| item.path == file_path && item.parent == group }
  file ||= group.new_file(file_path)
  targets.each do |target|
    unless target.source_build_phase.files.any? { |item| item.file_ref == file }
      target.source_build_phase.add_file_reference(file)
    end
  end
end

app_group = project.main_group.children.find { |group| group.name == 'LiveVoiceApp' }
add_source(project, app_group, 'LiveVoiceApp/VoiceSessionActivity.swift', [app])
add_source(project, app_group, 'LiveVoiceApp/VoiceSessionActivityBridge.m', [app])
shared = project.main_group.children.find { |group| group.path == 'LiveVoiceActivityShared' }
shared ||= project.main_group.new_group('LiveVoiceActivityShared', 'LiveVoiceActivityShared')
add_source(project, shared, 'LiveVoiceActivityAttributes.swift', [app, widget])
ui_tests = project.targets.find { |target| target.name == 'LiveVoiceAppUITests' }
ui_group = project.main_group.children.find { |item| item.path == 'LiveVoiceAppUITests' }
add_source(project, ui_group, 'SessionRuntimeUITests.swift', [ui_tests]) if ui_tests && ui_group
group = project.main_group.children.find { |item| item.path == 'LiveVoiceActivity' }
group ||= project.main_group.new_group('LiveVoiceActivity', 'LiveVoiceActivity')
add_source(project, group, 'LiveVoiceActivityWidget.swift', [widget])
group.new_file('Info.plist') unless group.children.any? { |item| item.path == 'Info.plist' }
assets = group.children.find { |item| item.path == 'Assets.xcassets' }
assets ||= group.new_file('Assets.xcassets')
unless widget.resources_build_phase.files.any? { |item| item.file_ref == assets }
  widget.resources_build_phase.add_file_reference(assets)
end

widget.build_configurations.each do |configuration|
  base = app.build_configurations.find { |item| item.name == configuration.name }.build_settings
  settings = configuration.build_settings
  settings.merge!({
    'APPLICATION_EXTENSION_API_ONLY' => 'YES',
    'CODE_SIGN_STYLE' => 'Automatic',
    'INFOPLIST_FILE' => 'LiveVoiceActivity/Info.plist',
    'GENERATE_INFOPLIST_FILE' => 'NO',
    'IPHONEOS_DEPLOYMENT_TARGET' => '16.2',
    'PRODUCT_BUNDLE_IDENTIFIER' => "#{base['PRODUCT_BUNDLE_IDENTIFIER']}.activity",
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'SKIP_INSTALL' => 'YES',
    'SWIFT_VERSION' => '5.0',
    'SWIFT_ENABLE_EXPLICIT_MODULES' => 'NO',
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'MARKETING_VERSION' => base['MARKETING_VERSION'],
    'CURRENT_PROJECT_VERSION' => base['CURRENT_PROJECT_VERSION'],
    'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks'],
  })
  # Only inherit an existing local team; never put personal signing IDs here.
  settings['DEVELOPMENT_TEAM'] = base['DEVELOPMENT_TEAM'] if base['DEVELOPMENT_TEAM']
end
unless app.dependencies.any? { |dependency| dependency.native_target_uuid == widget.uuid }
  app.add_dependency(widget)
end
embed = app.copy_files_build_phases.find { |phase| phase.name == 'Embed App Extensions' }
embed ||= app.new_copy_files_build_phase('Embed App Extensions')
embed.dst_subfolder_spec = '13'
unless embed.files.any? { |item| item.file_ref == widget.product_reference }
  embedded = embed.add_file_reference(widget.product_reference)
  embedded.settings = {'ATTRIBUTES' => ['RemoveHeadersOnCopy']}
end
project.root_object.attributes['TargetAttributes'] ||= {}
project.root_object.attributes['TargetAttributes'][widget.uuid] ||= {'ProvisioningStyle' => 'Automatic'}
project.save
puts 'Configured local Live Activity extension.'
