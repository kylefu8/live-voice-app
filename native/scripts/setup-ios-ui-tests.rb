#!/usr/bin/env ruby

require 'pathname'
require 'xcodeproj'

PROJECT_NAME = 'LiveVoiceApp'
TEST_TARGET_NAME = 'LiveVoiceAppUITests'
DEPLOYMENT_TARGET = '15.1'
REPOSITORY_ROOT = Pathname(__dir__).parent
PROJECT_PATH = REPOSITORY_ROOT.join('ios', "#{PROJECT_NAME}.xcodeproj")
TEST_SOURCE_PATH = REPOSITORY_ROOT.join('ios', TEST_TARGET_NAME, "#{TEST_TARGET_NAME}.swift")
SCHEME_PATH = PROJECT_PATH.join('xcshareddata', 'xcschemes', "#{PROJECT_NAME}.xcscheme")

abort("Missing Xcode project: #{PROJECT_PATH}") unless PROJECT_PATH.directory?
abort("Missing UI test source: #{TEST_SOURCE_PATH}") unless TEST_SOURCE_PATH.file?

project = Xcodeproj::Project.open(PROJECT_PATH.to_s)
app_target = project.targets.find { |target| target.name == PROJECT_NAME }
abort("Missing application target: #{PROJECT_NAME}") unless app_target

test_target = project.targets.find { |target| target.name == TEST_TARGET_NAME }
unless test_target
  test_target = project.new_target(
    :ui_test_bundle,
    TEST_TARGET_NAME,
    :ios,
    DEPLOYMENT_TARGET,
    nil,
    :swift,
  )
end

test_group = project.main_group.children.find do |child|
  child.isa == 'PBXGroup' &&
    (child.name == TEST_TARGET_NAME || child.path == TEST_TARGET_NAME)
end
test_group ||= project.main_group.new_group(TEST_TARGET_NAME, TEST_TARGET_NAME)

test_source = project.files.find do |file_ref|
  file_ref.isa == 'PBXFileReference' &&
    file_ref.real_path.expand_path == TEST_SOURCE_PATH.expand_path
end
unless test_source
  test_source = test_group.new_file(TEST_SOURCE_PATH.basename.to_s)
end
test_group.children << test_source unless test_group.children.include?(test_source)

unless test_target.source_build_phase.files.any? { |build_file| build_file.file_ref == test_source }
  test_target.source_build_phase.add_file_reference(test_source)
end

has_xctest = test_target.frameworks_build_phase.files.any? { |build_file|
  file_ref = build_file.file_ref
  file_ref && (
    file_ref.name == 'XCTest.framework' ||
      file_ref.path.to_s.end_with?('/XCTest.framework')
  )
}
unless has_xctest
  test_target.add_system_framework('XCTest')
end

unless test_target.dependencies.any? { |dependency| dependency.native_target_uuid == app_target.uuid }
  test_target.add_dependency(app_target)
end

project.root_object.attributes['TargetAttributes'] ||= {}
project.root_object.attributes['TargetAttributes'][test_target.uuid] ||= {}
project.root_object.attributes['TargetAttributes'][test_target.uuid]['TestTargetID'] = app_target.uuid

test_target.build_configurations.each do |configuration|
  settings = configuration.build_settings
  settings['CLANG_ENABLE_MODULES'] = 'YES'
  settings['CODE_SIGN_STYLE'] = 'Automatic'
  settings['GENERATE_INFOPLIST_FILE'] = 'YES'
  settings['IPHONEOS_DEPLOYMENT_TARGET'] = DEPLOYMENT_TARGET
  settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.kylefu.livevoice.uitests'
  settings['PRODUCT_NAME'] = TEST_TARGET_NAME
  settings['SUPPORTED_PLATFORMS'] = 'iphoneos iphonesimulator'
  settings['SWIFT_VERSION'] = '5.0'
  settings['TARGETED_DEVICE_FAMILY'] = '1,2'
  settings['TEST_TARGET_NAME'] = PROJECT_NAME
end

project.save

unless SCHEME_PATH.file?
  abort("Missing shared scheme: #{SCHEME_PATH}")
end

scheme = Xcodeproj::XCScheme.new(SCHEME_PATH.to_s)
build_entries = (scheme.build_action.entries || []).select do |entry|
  entry.buildable_references.all? do |reference|
    project.targets.any? { |target| target.uuid == reference.target_uuid }
  end
end
scheme.build_action.entries = build_entries
has_test_build_entry = build_entries.any? { |entry|
  entry.buildable_references.any? { |reference| reference.target_uuid == test_target.uuid }
}
unless has_test_build_entry
  scheme.add_build_target(test_target, false)
end

testables = (scheme.test_action.testables || []).select do |testable|
  testable.buildable_references.any? do |reference|
    project.targets.any? { |target| target.uuid == reference.target_uuid }
  end
end.reject do |testable|
  testable.buildable_references.any? { |reference| reference.target_uuid == test_target.uuid }
end
testables << Xcodeproj::XCScheme::TestAction::TestableReference.new(test_target)
scheme.test_action.testables = testables

macro_expansions = scheme.test_action.macro_expansions
unless macro_expansions.any? { |macro| macro.buildable_reference.target_uuid == app_target.uuid }
  scheme.test_action.add_macro_expansion(Xcodeproj::XCScheme::MacroExpansion.new(app_target))
end

scheme.save!

puts "Configured #{TEST_TARGET_NAME} in #{PROJECT_PATH}"
puts "Run xcodebuild test using ios/#{PROJECT_NAME}.xcworkspace, scheme #{PROJECT_NAME}, and an installed simulator destination."
